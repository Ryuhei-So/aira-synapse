#!/usr/bin/env node
/**
 * agdb-index.mjs — Rebuild vector or lexical index for an aira-graphdb corpus
 *
 * Usage:
 *   node scripts/agdb-index.mjs --corpus <id> --type <vector|lexical>
 *                               [--db <path>] [--config <path>]
 *
 * Environment:
 *   OPENAI_API_KEY        — required for vector rebuild (embedding)
 *   AIRA_GRAPHDB_DB_PATH  — default DB path (overridden by --db)
 *   AIRA_GRAPHDB_NATIVE_CMD — path to aira-graphdb-native binary
 */

import { resolve } from 'node:path';
import { readFileSync, openSync, closeSync, unlinkSync, writeFileSync } from 'node:fs';

import { loadMemGraphRagConfig, resolveConfigFromEnv, resolveApiKey } from '../dist/infrastructure/config/index.js';
import {
  AiraGraphDbNativeClient,
  AiraGraphDbVectorIndex, AiraGraphDbMemoryStore, AiraGraphDbLexicalRetriever,
} from '../dist/infrastructure/index.js';
import { AiraGraphDbIndexStatusManager } from '../dist/infrastructure/storage/aira-graphdb/AiraGraphDbAdapters.js';
import { upsertVectors } from '../dist/application/index.js';
import { OpenAIEmbeddingProvider } from '../dist/infrastructure/index.js';
import { BatchEmbeddingProvider } from '../dist/infrastructure/index.js';

// ─── CLI Parsing ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { corpusId: null, indexType: null, dbPath: null, configPath: null };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--corpus': opts.corpusId = args[++i]; break;
      case '--type': opts.indexType = args[++i]; break;
      case '--db': opts.dbPath = args[++i]; break;
      case '--config': opts.configPath = args[++i]; break;
      case '--help': printHelp(); process.exit(0);
    }
  }
  if (!opts.corpusId || !opts.indexType || !['vector', 'lexical'].includes(opts.indexType)) {
    printHelp();
    process.exit(1);
  }
  return opts;
}

function printHelp() {
  console.log(`Usage: node scripts/agdb-index.mjs --corpus <id> --type <vector|lexical> [options]

Options:
  --corpus <id>    Corpus ID (required)
  --type <type>    Index type: vector or lexical (required)
  --db <path>      Database path (default: data/<corpus>.agdb)
  --config <path>  Config file path
  --help           Show this help`);
}

// ─── Lock (shared with agdb-ingest.mjs) ─────────────────────────────────────

function acquireLock(dbPath) {
  const lockPath = dbPath + '.lock';
  try {
    const fd = openSync(lockPath, 'wx');
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    return lockPath;
  } catch (err) {
    if (err.code === 'EEXIST') {
      try {
        const pid = parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
        process.kill(pid, 0);
        console.error(`ERROR: Lock held by PID ${pid}. Exiting.`);
        process.exit(1);
      } catch (killErr) {
        if (killErr.code === 'ESRCH') {
          console.warn(`WARN: Stale lock. Removing.`);
          unlinkSync(lockPath);
          return acquireLock(dbPath);
        }
        throw killErr;
      }
    }
    throw err;
  }
}

function releaseLock(lockPath) {
  try { unlinkSync(lockPath); } catch { /* ignore */ }
}

// ─── NodeId Helpers ─────────────────────────────────────────────────────────

function entityNodeId(documentId, key) { return `entity:${documentId}:${key}`; }
function factNodeId(factId) { return `fact:${factId}`; }
function passageNodeId(passageId) { return `passage:${passageId}`; }
function entityKey(name) { return name.toLowerCase().replace(/\s+/g, '_'); }

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv);
  const { corpusId, indexType } = opts;

  const configPath = opts.configPath || resolve(process.cwd(), 'config/default.memgraphrag.yml');
  const baseConfig = loadMemGraphRagConfig(configPath);
  const config = resolveConfigFromEnv(baseConfig);
  const apiKey = resolveApiKey(config.providers?.apiKeyFile);

  const dbPath = opts.dbPath
    || process.env.AIRA_GRAPHDB_DB_PATH
    || resolve(`data/${corpusId}.agdb`);

  console.log(`[agdb-index] corpus=${corpusId} type=${indexType} db=${dbPath}`);

  const lockPath = acquireLock(dbPath);
  console.log(`[agdb-index] Lock acquired`);

  const client = new AiraGraphDbNativeClient(dbPath);
  const vectorIndex = new AiraGraphDbVectorIndex(client);
  const memoryStore = new AiraGraphDbMemoryStore(client);
  const lexicalRetriever = new AiraGraphDbLexicalRetriever(client);
  const statusMgr = new AiraGraphDbIndexStatusManager(client);

  try {
    await statusMgr.save(corpusId, indexType, 'rebuilding');

    // Load memory snapshot
    const snapshot = await memoryStore.load(corpusId);
    const facts = snapshot.facts || [];
    const passages = snapshot.passages || [];

    if (indexType === 'vector') {
      // 1. Delete all vectors
      const deleteResult = await vectorIndex.deleteByCorpus(corpusId);
      console.log(`[agdb-index] Deleted ${deleteResult.deleted} vectors`);

      // 2. Rebuild GraphNode[] from facts/passages
      const nodes = [];

      // Fact nodes
      for (const fact of facts) {
        nodes.push({
          nodeId: factNodeId(fact.factId),
          corpusId,
          layer: 'fact',
          ref: { sourceDocumentIds: fact.sourceDocumentIds, headEntity: fact.headEntity, relation: fact.relation, tailEntity: fact.tailEntity },
          label: `${fact.headEntity} ${fact.relation} ${fact.tailEntity}`,
        });
      }

      // Passage nodes
      for (const passage of passages) {
        nodes.push({
          nodeId: passageNodeId(passage.passageId),
          corpusId,
          layer: 'passage',
          ref: passage,
          label: passage.text?.slice(0, 100) || '',
        });
      }

      // Entity nodes (document-scoped, derived from facts)
      const entitySet = new Map(); // `${docId}:${key}` → { name, docId }
      for (const fact of facts) {
        const docId = fact.sourceDocumentIds?.[0] || 'unknown';
        for (const [name, type] of [[fact.headEntity, fact.headType], [fact.tailEntity, fact.tailType]]) {
          const key = entityKey(name);
          const fullKey = `${docId}:${key}`;
          if (!entitySet.has(fullKey)) {
            entitySet.set(fullKey, { name, docId, key });
          }
        }
      }
      for (const [_, info] of entitySet) {
        nodes.push({
          nodeId: entityNodeId(info.docId, info.key),
          corpusId,
          layer: 'entity',
          ref: { sourceDocumentIds: [info.docId], entityName: info.name },
          label: info.name,
        });
      }

      // 3. Embed and upsert
      const batchMode = config?.providers?.embedding?.batch_mode === true;
      const embeddingModel = config?.providers?.embedding?.model || 'text-embedding-3-small';
      const embeddingDimensions = config?.providers?.embedding?.dimensions;
      const embeddingProvider = batchMode
        ? new BatchEmbeddingProvider({
            apiKey,
            model: embeddingModel,
            dimensions: embeddingDimensions,
            outputDir: resolve(config?.providers?.embedding?.batch_output_dir || './data/memgraphrag/batch'),
          })
        : new OpenAIEmbeddingProvider({ apiKey, model: embeddingModel, dimensions: embeddingDimensions });
      if (batchMode) console.log(`[agdb-index] Batch mode ON (50% cost reduction, 24h SLA)`);
      console.log(`[agdb-index] Rebuilding vectors for ${nodes.length} nodes...`);
      await upsertVectors(vectorIndex, embeddingProvider, nodes);
      console.log(`[agdb-index] Vector rebuild complete`);

    } else {
      // Lexical rebuild
      const deleteResult = await lexicalRetriever.deleteByCorpus(corpusId);
      console.log(`[agdb-index] Deleted ${deleteResult.deleted} lexical entries`);

      // Re-index passages in batches
      const BATCH = 500;
      for (let i = 0; i < passages.length; i += BATCH) {
        await lexicalRetriever.indexPassages(corpusId, passages.slice(i, i + BATCH));
      }
      console.log(`[agdb-index] Lexical rebuild complete (${passages.length} passages)`);
    }

    await statusMgr.save(corpusId, indexType, 'indexed');
    console.log(`[agdb-index] Status: indexed`);

  } catch (err) {
    console.error(`[agdb-index] ERROR: ${err.message}`);
    await statusMgr.save(corpusId, indexType, 'failed').catch(() => {});
    process.exitCode = 1;
  } finally {
    await client.close();
    releaseLock(lockPath);
  }
}

main().catch(err => {
  console.error(`[agdb-index] Fatal: ${err.message}`);
  process.exit(1);
});
