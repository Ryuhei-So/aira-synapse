#!/usr/bin/env node
/**
 * agdb-ingest.mjs — Ingest markdown documents into aira-graphdb
 *
 * Usage:
 *   node scripts/agdb-ingest.mjs <corpus-dir> --corpus <id> [--db <path>] [--config <path>]
 *                                 [--skip-vector] [--skip-lexical] [--concurrency <N>]
 *
 * Environment:
 *   OPENAI_API_KEY        — required for LLM extraction and embedding
 *   AIRA_GRAPHDB_DB_PATH  — default DB path (overridden by --db)
 *   AIRA_GRAPHDB_NATIVE_CMD — path to aira-graphdb-native binary
 */

import { resolve, relative, basename } from 'node:path';
import { readFileSync, readdirSync, statSync, openSync, closeSync, unlinkSync, writeFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';

import { loadMemGraphRagConfig, resolveConfigFromEnv, resolveApiKey } from '../dist/infrastructure/config/index.js';
import {
  AiraGraphDbNativeClient, AiraGraphDbGraphStore,
  AiraGraphDbVectorIndex, AiraGraphDbMemoryStore, AiraGraphDbLexicalRetriever,
  PythonSidecarExtractor,
} from '../dist/infrastructure/index.js';
import { AiraGraphDbIndexStatusManager } from '../dist/infrastructure/storage/aira-graphdb/AiraGraphDbAdapters.js';
import { chunkMarkdownDocument, chunkMarkdownDocumentWithGinza, toExtractionChunk, upsertVectors } from '../dist/application/index.js';
import { LLMExtractionAgent } from '../dist/application/index.js';
import { OpenAIEmbeddingProvider } from '../dist/infrastructure/index.js';
import { BatchEmbeddingProvider } from '../dist/infrastructure/index.js';
import { OpenAILLMProvider } from '../dist/infrastructure/index.js';

// ─── CLI Parsing ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { corpusDir: null, corpusId: null, dbPath: null, configPath: null, skipVector: false, skipLexical: false, concurrency: 5 };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--corpus': opts.corpusId = args[++i]; break;
      case '--db': opts.dbPath = args[++i]; break;
      case '--config': opts.configPath = args[++i]; break;
      case '--skip-vector': opts.skipVector = true; break;
      case '--skip-lexical': opts.skipLexical = true; break;
      case '--concurrency': opts.concurrency = parseInt(args[++i], 10) || 5; break;
      case '--help': printHelp(); process.exit(0);
      default:
        if (!args[i].startsWith('-') && !opts.corpusDir) opts.corpusDir = args[i];
    }
  }
  if (!opts.corpusDir || !opts.corpusId) {
    printHelp();
    process.exit(1);
  }
  return opts;
}

function printHelp() {
  console.log(`Usage: node scripts/agdb-ingest.mjs <corpus-dir> --corpus <id> [options]

Options:
  --corpus <id>        Corpus ID (required)
  --db <path>          Database path (default: data/<corpus>.agdb)
  --config <path>      Config file path
  --skip-vector        Skip vector index upsert
  --skip-lexical       Skip lexical index
  --concurrency <N>    LLM extraction concurrency (default: 5)
  --help               Show this help`);
}

// ─── DocumentIdManager ──────────────────────────────────────────────────────

function normalizeDocumentId(corpusDir, filePath) {
  const realCorpus = realpathSync(corpusDir);
  const realDoc = realpathSync(filePath);
  if (!realDoc.startsWith(realCorpus)) {
    throw new Error(`File ${filePath} is not under corpus dir ${corpusDir}`);
  }
  return relative(realCorpus, realDoc).replace(/\\/g, '/');
}

// ─── DocumentStatusManager ──────────────────────────────────────────────────

class DocumentStatusManager {
  constructor() { this.statuses = new Map(); }
  setStatus(docId, status) { this.statuses.set(docId, status); }
  getStatus(docId) { return this.statuses.get(docId) || 'pending'; }
  getSummary() {
    let indexed = 0, failed = 0, pending = 0;
    for (const s of this.statuses.values()) {
      if (s === 'indexed') indexed++;
      else if (s === 'failed') failed++;
      else pending++;
    }
    return { total: this.statuses.size, indexed, failed, pending };
  }
  markAllProcessingAsFailed() {
    for (const [k, v] of this.statuses) {
      if (v === 'processing') this.statuses.set(k, 'failed');
    }
  }
}

// ─── Lock ───────────────────────────────────────────────────────────────────

function acquireLock(dbPath) {
  const lockPath = dbPath + '.lock';
  try {
    const fd = openSync(lockPath, 'wx');
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    return lockPath;
  } catch (err) {
    if (err.code === 'EEXIST') {
      // Check stale lock
      try {
        const pid = parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
        process.kill(pid, 0); // throws if not running
        console.error(`ERROR: Lock held by PID ${pid}. Exiting.`);
        process.exit(1);
      } catch (killErr) {
        if (killErr.code === 'ESRCH') {
          console.warn(`WARN: Stale lock (PID not running). Removing.`);
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

// ─── NodeId Helpers (inline from StageIVGraphProjector) ─────────────────────

function entityNodeId(documentId, entityKey) {
  return `entity:${documentId}:${entityKey}`;
}
function factNodeId(factId) { return `fact:${factId}`; }
function passageNodeId(passageId) { return `passage:${passageId}`; }

function entityKey(name) {
  return name.toLowerCase().replace(/\s+/g, '_');
}

// ─── Concurrency Helper ─────────────────────────────────────────────────────

async function mapConcurrent(items, concurrency, fn) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

// ─── Main Pipeline ──────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv);
  const corpusDir = resolve(opts.corpusDir);
  const corpusId = opts.corpusId;

  // Load config
  const configPath = opts.configPath || resolve(process.cwd(), 'config/default.memgraphrag.yml');
  const baseConfig = loadMemGraphRagConfig(configPath);
  const config = resolveConfigFromEnv(baseConfig);
  const apiKey = resolveApiKey(config.providers?.apiKeyFile);

  // Resolve DB path
  const dbPath = opts.dbPath
    || process.env.AIRA_GRAPHDB_DB_PATH
    || resolve(`data/${corpusId}.agdb`);

  console.log(`[agdb-ingest] corpus=${corpusId} dir=${corpusDir} db=${dbPath}`);
  console.log(`[agdb-ingest] skipVector=${opts.skipVector} skipLexical=${opts.skipLexical} concurrency=${opts.concurrency}`);

  // Acquire lock
  const lockPath = acquireLock(dbPath);
  console.log(`[agdb-ingest] Lock acquired: ${lockPath}`);

  // SIGINT/SIGTERM handler
  const statusMgr = new DocumentStatusManager();
  let shuttingDown = false;
  const cleanup = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    statusMgr.markAllProcessingAsFailed();
    const summary = statusMgr.getSummary();
    console.log(`\n[agdb-ingest] Interrupted. ${summary.indexed} indexed, ${summary.failed} failed.`);
    releaseLock(lockPath);
    process.exit(1);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Spawn client
  const client = new AiraGraphDbNativeClient(dbPath);
  const graphStore = new AiraGraphDbGraphStore(client);
  const vectorIndex = new AiraGraphDbVectorIndex(client);
  const memoryStore = new AiraGraphDbMemoryStore(client);
  const lexicalRetriever = new AiraGraphDbLexicalRetriever(client);

  // Create providers
  const llmProvider = new OpenAILLMProvider({ apiKey, model: config?.indexing?.model || config?.providers?.llm?.model || 'gpt-4.1-mini' });
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
  if (batchMode) console.log(`[agdb-ingest] Batch mode ON (50% cost reduction, 24h SLA)`);
  const extractionAgent = new LLMExtractionAgent(llmProvider, 'en');

  // Start Python sidecar for GINZA-based Japanese chunking/NER
  let sidecar = null;
  try {
    sidecar = new PythonSidecarExtractor({
      requestTimeoutMs: 30_000,
      healthcheckTimeoutMs: 10_000,
    });
    const health = await sidecar.healthCheck();
    if (health.healthy) {
      console.log(`[agdb-ingest] GINZA sidecar: ACTIVE (JA sentence chunking enabled)`);
    } else {
      console.warn(`[agdb-ingest] GINZA sidecar: UNHEALTHY, falling back to paragraph chunking`);
      sidecar = null;
    }
  } catch (err) {
    console.warn(`[agdb-ingest] GINZA sidecar: UNAVAILABLE (${err.message}), falling back to paragraph chunking`);
    sidecar = null;
  }

  // Enumerate .md files
  const mdFiles = readdirSync(corpusDir, { recursive: true })
    .filter(f => f.endsWith('.md'))
    .map(f => resolve(corpusDir, f))
    .filter(f => statSync(f).isFile());

  console.log(`[agdb-ingest] Found ${mdFiles.length} markdown files`);

  // Process each document sequentially
  for (const filePath of mdFiles) {
    if (shuttingDown) break;

    const documentId = normalizeDocumentId(corpusDir, filePath);
    statusMgr.setStatus(documentId, 'processing');
    const startTime = Date.now();

    try {
      const markdown = readFileSync(filePath, 'utf8');
      if (!markdown.trim()) {
        statusMgr.setStatus(documentId, 'indexed');
        continue;
      }

      // 1. Chunk — use GINZA for Japanese, paragraph-based for English
      const isJapanese = /[\u3040-\u30ff\u4e00-\u9fff]/.test(markdown);
      const language = isJapanese ? 'ja' : 'en';
      const request = {
        corpusId, documentId,
        title: basename(filePath, '.md'),
        sourceUrl: '',
        markdown,
        language,
      };
      let chunks;
      if (isJapanese && sidecar) {
        try {
          chunks = await chunkMarkdownDocumentWithGinza(request, sidecar);
        } catch {
          chunks = chunkMarkdownDocument(request);
        }
      } else {
        chunks = chunkMarkdownDocument(request);
      }
      if (chunks.length === 0) {
        statusMgr.setStatus(documentId, 'indexed');
        continue;
      }

      // 2. Extract (concurrent within document)
      const extractionChunks = chunks.map(c => toExtractionChunk(corpusId, c, request));
      const records = await mapConcurrent(extractionChunks, opts.concurrency, (chunk) => extractionAgent.extract(chunk));

      // 3. Build graph data
      const nodes = [];
      const edges = [];
      const allFacts = [];
      const allPassages = [];
      const entityMap = new Map(); // key → { name, types, factCount }
      const now = new Date().toISOString();

      for (const record of records) {
        // Passage from extraction (already a full Passage object)
        const passage = record.sourcePassage;
        allPassages.push(passage);

        // Passage node
        const pNodeId = passageNodeId(passage.passageId);
        nodes.push({
          nodeId: pNodeId,
          corpusId,
          layer: 'passage',
          ref: passage,
          label: passage.text.slice(0, 100),
        });

        // Facts
        for (const candidate of record.candidateFacts) {
          const factId = `${documentId}:${candidate.headEntity}:${candidate.relation}:${candidate.tailEntity}`;
          const fact = {
            factId,
            schemaId: '',
            headEntity: candidate.headEntity,
            headType: candidate.headType,
            relation: candidate.relation,
            tailEntity: candidate.tailEntity,
            tailType: candidate.tailType,
            state: 'active',
            passageIds: [passage.passageId],
            sourceDocumentIds: [documentId],
            confidence: candidate.confidence,
            corpusId,
            createdAt: now,
            updatedAt: now,
          };
          allFacts.push(fact);

          const fNodeId = factNodeId(factId);
          nodes.push({
            nodeId: fNodeId,
            corpusId,
            layer: 'fact',
            ref: { sourceDocumentIds: [documentId], headEntity: candidate.headEntity, relation: candidate.relation, tailEntity: candidate.tailEntity },
            label: `${candidate.headEntity} ${candidate.relation} ${candidate.tailEntity}`,
          });

          // fact-evidence edge
          edges.push({
            edgeId: `fact-evidence:${factId}:${passage.passageId}`,
            corpusId,
            sourceNodeId: fNodeId,
            targetNodeId: pNodeId,
            relation: 'fact-evidence',
            weight: candidate.confidence,
          });

          // Entity nodes (document-scoped)
          const headKey = entityKey(candidate.headEntity);
          const tailKey = entityKey(candidate.tailEntity);
          for (const [key, name] of [[headKey, candidate.headEntity], [tailKey, candidate.tailEntity]]) {
            if (!entityMap.has(key)) {
              entityMap.set(key, { name, types: new Set(), factCount: 0 });
            }
            entityMap.get(key).factCount++;
          }
          entityMap.get(headKey).types.add(candidate.headType);
          entityMap.get(tailKey).types.add(candidate.tailType);

          // entity-cooccur edge
          if (headKey !== tailKey) {
            edges.push({
              edgeId: `entity-cooccur:${documentId}:${headKey}:${tailKey}:${factId}`,
              corpusId,
              sourceNodeId: entityNodeId(documentId, headKey),
              targetNodeId: entityNodeId(documentId, tailKey),
              relation: 'entity-cooccur',
              weight: candidate.confidence,
            });
          }

          // entity-mention edges
          edges.push({
            edgeId: `entity-mention:${documentId}:${headKey}:${passage.passageId}`,
            corpusId,
            sourceNodeId: entityNodeId(documentId, headKey),
            targetNodeId: pNodeId,
            relation: 'entity-mention',
            weight: 1.0,
          });
          if (headKey !== tailKey) {
            edges.push({
              edgeId: `entity-mention:${documentId}:${tailKey}:${passage.passageId}`,
              corpusId,
              sourceNodeId: entityNodeId(documentId, tailKey),
              targetNodeId: pNodeId,
              relation: 'entity-mention',
              weight: 1.0,
            });
          }
        }
      }

      // Add entity nodes
      for (const [key, info] of entityMap) {
        nodes.push({
          nodeId: entityNodeId(documentId, key),
          corpusId,
          layer: 'entity',
          ref: { sourceDocumentIds: [documentId], entityName: info.name, factCount: info.factCount },
          label: info.name,
        });
      }

      // 4. Delete existing document data
      await graphStore.deleteByDocument(corpusId, documentId);

      // 5. Upsert graph (batched)
      const BATCH = 500;
      for (let i = 0; i < nodes.length; i += BATCH) {
        await graphStore.upsertNodes(nodes.slice(i, i + BATCH));
      }
      for (let i = 0; i < edges.length; i += BATCH) {
        await graphStore.upsertEdges(edges.slice(i, i + BATCH));
      }

      // 6. Memory: load → merge → save
      const oldSnapshot = await memoryStore.load(corpusId);
      const mergedFacts = [
        ...(oldSnapshot.facts || []).filter(f => !f.sourceDocumentIds?.includes(documentId)),
        ...allFacts,
      ];
      const mergedPassages = [
        ...(oldSnapshot.passages || []).filter(p => p.metadata?.documentId !== documentId),
        ...allPassages,
      ];
      const snapshot = {
        corpusId,
        exportedAt: now,
        schemaVersion: oldSnapshot.schemaVersion ?? 0,
        schemas: oldSnapshot.schemas ?? [],
        facts: mergedFacts,
        passages: mergedPassages,
      };
      await memoryStore.save(snapshot);

      // 7. Vector upsert
      if (!opts.skipVector) {
        await upsertVectors(vectorIndex, embeddingProvider, nodes);
      }

      // 8. Lexical index
      if (!opts.skipLexical) {
        await lexicalRetriever.indexPassages(corpusId, allPassages);
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[agdb-ingest] ✓ ${documentId} (${nodes.length} nodes, ${edges.length} edges, ${elapsed}s)`);
      statusMgr.setStatus(documentId, 'indexed');

    } catch (err) {
      console.error(`[agdb-ingest] ✗ ${documentId}: ${err.message}`);
      // Recovery: restore old memory snapshot if available
      try {
        const oldSnapshot = await memoryStore.load(corpusId);
        if (oldSnapshot) await memoryStore.save(oldSnapshot);
      } catch { /* best effort */ }
      statusMgr.setStatus(documentId, 'failed');
    }
  }

  // Summary
  const summary = statusMgr.getSummary();
  console.log(`\n[agdb-ingest] Complete: ${summary.indexed}/${summary.total} indexed, ${summary.failed} failed`);

  // Cleanup
  await client.close();
  releaseLock(lockPath);
}

main().catch(err => {
  console.error(`[agdb-ingest] Fatal: ${err.message}`);
  process.exit(1);
});
