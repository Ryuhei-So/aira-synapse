#!/usr/bin/env node
/**
 * agdb-ingest-parallel.mjs — Parallel document ingest for benchmarking
 *
 * Like agdb-ingest.mjs but processes documents in parallel (--doc-parallel).
 * Memory snapshot is built in-memory and saved once at the end.
 * Designed for fresh corpus builds where no pre-existing data exists.
 *
 * Usage:
 *   node scripts/agdb-ingest-parallel.mjs <corpus-dir> --corpus <id> [--db <path>]
 *       [--config <path>] [--skip-vector] [--skip-lexical]
 *       [--concurrency <N>] [--doc-parallel <N>]
 *
 * Environment:
 *   OPENAI_API_KEY, AIRA_GRAPHDB_NATIVE_CMD, AIRA_GRAPHDB_DB_PATH
 */

import { resolve, relative, basename } from 'node:path';
import { readFileSync, readdirSync, statSync, openSync, closeSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { realpathSync } from 'node:fs';

import { loadMemGraphRagConfig, resolveConfigFromEnv, resolveApiKey } from '../dist/infrastructure/config/index.js';
import {
  AiraGraphDbNativeClient, AiraGraphDbGraphStore,
  AiraGraphDbVectorIndex, AiraGraphDbMemoryStore, AiraGraphDbLexicalRetriever,
  BatchEmbeddingProvider,
} from '../dist/infrastructure/index.js';
import { chunkMarkdownDocument, toExtractionChunk, upsertVectors } from '../dist/application/index.js';
import { LLMExtractionAgent } from '../dist/application/index.js';
import { OpenAIEmbeddingProvider } from '../dist/infrastructure/index.js';
import { OpenAILLMProvider } from '../dist/infrastructure/index.js';

// ─── CLI Parsing ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { corpusDir: null, corpusId: null, dbPath: null, configPath: null, skipVector: false, skipLexical: false, concurrency: 5, docParallel: 5, checkpointInterval: 20, noBatch: false, startFrom: 0, vectorOnly: false, batchEmbed: false };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--corpus': opts.corpusId = args[++i]; break;
      case '--db': opts.dbPath = args[++i]; break;
      case '--config': opts.configPath = args[++i]; break;
      case '--skip-vector': opts.skipVector = true; break;
      case '--skip-lexical': opts.skipLexical = true; break;
      case '--concurrency': opts.concurrency = parseInt(args[++i], 10) || 5; break;
      case '--doc-parallel': opts.docParallel = parseInt(args[++i], 10) || 5; break;
      case '--checkpoint': opts.checkpointInterval = parseInt(args[++i], 10) || 20; break;
      case '--no-batch': opts.noBatch = true; break;
      case '--start-from': opts.startFrom = parseInt(args[++i], 10) || 0; break;
      case '--vector-only': opts.vectorOnly = true; break;
      case '--batch-embed': opts.batchEmbed = true; break;
      case '--help': printHelp(); process.exit(0);
      default:
        if (!args[i].startsWith('-') && !opts.corpusDir) opts.corpusDir = args[i];
    }
  }
  if (!opts.corpusDir || !opts.corpusId) { printHelp(); process.exit(1); }
  return opts;
}

function printHelp() {
  console.log(`Usage: node scripts/agdb-ingest-parallel.mjs <corpus-dir> --corpus <id> [options]

Options:
  --corpus <id>        Corpus ID (required)
  --db <path>          Database path (default: data/<corpus>.agdb)
  --config <path>      Config file path
  --skip-vector        Skip vector index upsert
  --skip-lexical       Skip lexical index
  --concurrency <N>    LLM extraction concurrency per doc (default: 5)
  --doc-parallel <N>   Number of documents to process in parallel (default: 5)
  --checkpoint <N>     Persist every N documents (default: 20)
  --no-batch           Persist after every operation (slower but safer)
  --start-from <N>     Skip first N files (resume from checkpoint)
  --vector-only        Only run Phase B (vector upsert from existing graph nodes)
  --batch-embed        Use OpenAI Batch API for embeddings (50% cost, 24h SLA)
  --help               Show this help`);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function normalizeDocumentId(corpusDir, filePath) {
  const realCorpus = realpathSync(corpusDir);
  const realDoc = realpathSync(filePath);
  return relative(realCorpus, realDoc).replace(/\\/g, '/');
}

function entityNodeId(documentId, eKey) { return `entity:${documentId}:${eKey}`; }
function factNodeId(factId) { return `fact:${factId}`; }
function passageNodeId(passageId) { return `passage:${passageId}`; }
function entityKey(name) { return name.toLowerCase().replace(/\s+/g, '_'); }

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
          console.warn(`WARN: Stale lock removed.`);
          unlinkSync(lockPath);
          return acquireLock(dbPath);
        }
        throw killErr;
      }
    }
    throw err;
  }
}
function releaseLock(lockPath) { try { unlinkSync(lockPath); } catch {} }

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

/**
 * Process a single document: chunk → extract → build graph data
 * Returns { nodes, edges, facts, passages, documentId } or null on error.
 */
async function processDocument(filePath, corpusDir, corpusId, extractionAgent, concurrency) {
  const documentId = normalizeDocumentId(corpusDir, filePath);
  const markdown = readFileSync(filePath, 'utf8');
  if (!markdown.trim()) return { documentId, nodes: [], edges: [], facts: [], passages: [] };

  const request = {
    corpusId, documentId,
    title: basename(filePath, '.md'),
    sourceUrl: '',
    markdown,
    language: 'en',
  };
  const chunks = chunkMarkdownDocument(request);
  if (chunks.length === 0) return { documentId, nodes: [], edges: [], facts: [], passages: [] };

  const extractionChunks = chunks.map(c => toExtractionChunk(corpusId, c, request));
  const records = await mapConcurrent(extractionChunks, concurrency, (chunk) => extractionAgent.extract(chunk));

  const nodes = [];
  const edges = [];
  const facts = [];
  const passages = [];
  const entityMap = new Map();
  const now = new Date().toISOString();

  for (const record of records) {
    const passage = record.sourcePassage;
    passages.push(passage);

    const pNodeId = passageNodeId(passage.passageId);
    nodes.push({ nodeId: pNodeId, corpusId, layer: 'passage', ref: passage, label: passage.text.slice(0, 100) });

    for (const candidate of record.candidateFacts) {
      const factId = `${documentId}:${candidate.headEntity}:${candidate.relation}:${candidate.tailEntity}`;
      facts.push({
        factId, schemaId: '', headEntity: candidate.headEntity, headType: candidate.headType,
        relation: candidate.relation, tailEntity: candidate.tailEntity, tailType: candidate.tailType,
        state: 'active', passageIds: [passage.passageId], sourceDocumentIds: [documentId],
        confidence: candidate.confidence, corpusId, createdAt: now, updatedAt: now,
      });

      const fNodeId = factNodeId(factId);
      nodes.push({
        nodeId: fNodeId, corpusId, layer: 'fact',
        ref: { sourceDocumentIds: [documentId], headEntity: candidate.headEntity, relation: candidate.relation, tailEntity: candidate.tailEntity },
        label: `${candidate.headEntity} ${candidate.relation} ${candidate.tailEntity}`,
      });

      edges.push({ edgeId: `fact-evidence:${factId}:${passage.passageId}`, corpusId, sourceNodeId: fNodeId, targetNodeId: pNodeId, relation: 'fact-evidence', weight: candidate.confidence });

      const headKey = entityKey(candidate.headEntity);
      const tailKey = entityKey(candidate.tailEntity);
      for (const [key, name] of [[headKey, candidate.headEntity], [tailKey, candidate.tailEntity]]) {
        if (!entityMap.has(key)) entityMap.set(key, { name, types: new Set(), factCount: 0 });
        entityMap.get(key).factCount++;
      }
      entityMap.get(headKey).types.add(candidate.headType);
      entityMap.get(tailKey).types.add(candidate.tailType);

      if (headKey !== tailKey) {
        edges.push({ edgeId: `entity-cooccur:${documentId}:${headKey}:${tailKey}:${factId}`, corpusId, sourceNodeId: entityNodeId(documentId, headKey), targetNodeId: entityNodeId(documentId, tailKey), relation: 'entity-cooccur', weight: candidate.confidence });
      }
      edges.push({ edgeId: `entity-mention:${documentId}:${headKey}:${passage.passageId}`, corpusId, sourceNodeId: entityNodeId(documentId, headKey), targetNodeId: pNodeId, relation: 'entity-mention', weight: 1.0 });
      if (headKey !== tailKey) {
        edges.push({ edgeId: `entity-mention:${documentId}:${tailKey}:${passage.passageId}`, corpusId, sourceNodeId: entityNodeId(documentId, tailKey), targetNodeId: pNodeId, relation: 'entity-mention', weight: 1.0 });
      }
    }
  }

  for (const [key, info] of entityMap) {
    nodes.push({ nodeId: entityNodeId(documentId, key), corpusId, layer: 'entity', ref: { sourceDocumentIds: [documentId], entityName: info.name, factCount: info.factCount }, label: info.name });
  }

  return { documentId, nodes, edges, facts, passages };
}

// ─── Vector-Only Phase ──────────────────────────────────────────────────────
// Reads all graph nodes from DB and generates+upserts their vectors.
// Uses Batch API if configured for 50% cost reduction.

async function runVectorOnlyPhase(client, vectorIndex, embeddingProvider, corpusId, opts) {
  console.log(`[vector-only] Reading graph nodes from DB file...`);

  // Read the DB JSON file directly to get all nodes
  const dbPath = opts.dbPath || process.env.AIRA_GRAPHDB_DB_PATH || resolve(`data/${corpusId}.agdb`);
  const raw = JSON.parse(readFileSync(dbPath, 'utf8'));
  const dbNodes = Object.values(raw.nodes || {});

  // Filter by corpusId and build items
  const items = [];
  const layerCounts = { passage: 0, fact: 0, entity: 0, other: 0 };
  for (const n of dbNodes) {
    if (n.corpusId && n.corpusId !== corpusId) continue;
    const layer = n.layer || 'other';
    layerCounts[layer] = (layerCounts[layer] || 0) + 1;
    items.push({
      nodeId: n.nodeId,
      corpusId: n.corpusId || corpusId,
      layer,
      ref: n.ref || {},
      label: n.label || n.nodeId,
    });
  }

  console.log(`[vector-only] Nodes by layer:`, layerCounts);
  console.log(`[vector-only] Total: ${items.length} nodes to embed`);

  if (items.length === 0) {
    console.log(`[vector-only] No nodes found. Run Phase A (graph ingest) first.`);
    return;
  }

  if (opts.batchEmbed) {
    // Batch API: split into chunks that won't exceed V8/memory limits
    // 10K items × 3072 dims × 8 bytes ≈ 245MB per chunk (safe)
    const BATCH_CHUNK = 10000;
    for (let i = 0; i < items.length; i += BATCH_CHUNK) {
      const chunk = items.slice(i, i + BATCH_CHUNK);
      console.log(`[vector-only] Submitting batch ${Math.floor(i / BATCH_CHUNK) + 1}/${Math.ceil(items.length / BATCH_CHUNK)} (${chunk.length} items) to Batch API...`);
      console.log(`[vector-only] This will upload to OpenAI and poll until complete (up to 24h).`);
      await upsertVectors(vectorIndex, embeddingProvider, chunk);
      console.log(`[vector-only] Batch ${Math.floor(i / BATCH_CHUNK) + 1} complete. Persisting...`);
      await client.request('persist');
    }
  } else {
    // Realtime: process in smaller chunks
    const EMBED_BATCH = 100;
    let done = 0;
    const startTime = Date.now();
    
    await client.request('batch_begin');
    for (let i = 0; i < items.length; i += EMBED_BATCH) {
      const chunk = items.slice(i, i + EMBED_BATCH);
      await upsertVectors(vectorIndex, embeddingProvider, chunk);
      done += chunk.length;
      if (done % 500 === 0 || i + EMBED_BATCH >= items.length) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const rate = (done / Math.max(elapsed / 60, 0.01)).toFixed(0);
        console.log(`[vector-only] ${done}/${items.length} | ${elapsed}s | ${rate}/min`);
        await client.request('batch_commit');
        if (i + EMBED_BATCH < items.length) await client.request('batch_begin');
      }
    }
  }

  console.log(`[vector-only] Done. ${items.length} vectors upserted.`);
}

// ─── Main Pipeline ──────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv);
  const corpusDir = resolve(opts.corpusDir);
  const corpusId = opts.corpusId;

  const configPath = opts.configPath || resolve(process.cwd(), 'config/default.memgraphrag.yml');
  const baseConfig = loadMemGraphRagConfig(configPath);
  const config = resolveConfigFromEnv(baseConfig);
  const apiKey = resolveApiKey(config.providers?.apiKeyFile);

  const dbPath = opts.dbPath || process.env.AIRA_GRAPHDB_DB_PATH || resolve(`data/${corpusId}.agdb`);

  console.log(`[agdb-ingest-parallel] corpus=${corpusId} dir=${corpusDir} db=${dbPath}`);
  console.log(`[agdb-ingest-parallel] docParallel=${opts.docParallel} concurrency=${opts.concurrency}`);
  console.log(`[agdb-ingest-parallel] skipVector=${opts.skipVector} skipLexical=${opts.skipLexical}`);
  console.log(`[agdb-ingest-parallel] batchEmbed=${opts.batchEmbed} vectorOnly=${opts.vectorOnly}`);

  const lockPath = acquireLock(dbPath);
  let shuttingDown = false;
  const cleanup = () => { if (shuttingDown) return; shuttingDown = true; releaseLock(lockPath); process.exit(1); };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  const client = new AiraGraphDbNativeClient(dbPath);
  const graphStore = new AiraGraphDbGraphStore(client);
  const vectorIndex = new AiraGraphDbVectorIndex(client);
  const memoryStore = new AiraGraphDbMemoryStore(client);
  const lexicalRetriever = new AiraGraphDbLexicalRetriever(client);

  // Choose embedding provider
  const embeddingModel = config?.providers?.embedding?.model || 'text-embedding-3-large';
  const embeddingDimensions = config?.providers?.embedding?.dimensions || 3072;
  const batchOutputDir = resolve(process.cwd(), config?.providers?.embedding?.batch_output_dir || './data/memgraphrag/batch');
  
  const embeddingProvider = opts.batchEmbed
    ? new BatchEmbeddingProvider({
        apiKey,
        model: embeddingModel,
        dimensions: embeddingDimensions,
        outputDir: batchOutputDir,
        pollIntervalMs: 30_000,
      })
    : new OpenAIEmbeddingProvider({
        apiKey,
        model: embeddingModel,
        dimensions: embeddingDimensions,
      });
  console.log(`[agdb-ingest-parallel] embedding: ${embeddingModel} (${embeddingDimensions}d) ${opts.batchEmbed ? 'BATCH API' : 'realtime'}`);

  // ─── Vector-Only Mode ──────────────────────────────────────────────────────
  if (opts.vectorOnly) {
    await runVectorOnlyPhase(client, vectorIndex, embeddingProvider, corpusId, opts);
    await client.close();
    releaseLock(lockPath);
    return;
  }

  const llmProvider = new OpenAILLMProvider({ apiKey, model: config?.indexing?.model || config?.providers?.llm?.model || 'gpt-4.1-mini' });
  const extractionAgent = new LLMExtractionAgent(llmProvider, 'en');

  // Enumerate .md files
  const mdFiles = readdirSync(corpusDir, { recursive: true })
    .filter(f => f.endsWith('.md'))
    .map(f => resolve(corpusDir, f))
    .filter(f => statSync(f).isFile());

  console.log(`[agdb-ingest-parallel] Found ${mdFiles.length} markdown files`);
  
  // Skip files for resume
  if (opts.startFrom > 0) {
    mdFiles.splice(0, opts.startFrom);
    console.log(`[agdb-ingest-parallel] Resuming from file #${opts.startFrom}, ${mdFiles.length} remaining`);
  }
  
  const startTime = Date.now();

  // Enter batch mode (unless --no-batch)
  if (!opts.noBatch) {
    await client.request('batch_begin');
  }

  // ─── Phase 1: Parallel extraction (CPU/LLM bound) ──────────────────────────
  // Process documents in parallel batches. Graph upsert is serialized per batch.
  let indexed = 0, failed = 0;
  let uncommittedDocs = 0;
  const allFacts = [];
  const allPassages = [];
  const BATCH_SIZE = opts.docParallel;
  const CHECKPOINT_INTERVAL = opts.checkpointInterval;
  const EMBED_BATCH_SIZE = 100; // Max texts per embedding API call

  for (let batchStart = 0; batchStart < mdFiles.length; batchStart += BATCH_SIZE) {
    if (shuttingDown) break;
    const batch = mdFiles.slice(batchStart, batchStart + BATCH_SIZE);

    const results = await Promise.allSettled(
      batch.map(f => processDocument(f, corpusDir, corpusId, extractionAgent, opts.concurrency))
    );

    // Serialize graph writes for this batch
    for (const result of results) {
      if (result.status === 'rejected') {
        failed++;
        console.error(`[agdb-ingest-parallel] ✗ ${result.reason?.message || result.reason}`);
        continue;
      }
      const { documentId, nodes, edges, facts, passages } = result.value;
      if (nodes.length === 0) { indexed++; uncommittedDocs++; continue; }

      try {
        // Upsert graph
        const UPSERT_BATCH = 500;
        for (let i = 0; i < nodes.length; i += UPSERT_BATCH) {
          await graphStore.upsertNodes(nodes.slice(i, i + UPSERT_BATCH));
        }
        for (let i = 0; i < edges.length; i += UPSERT_BATCH) {
          await graphStore.upsertEdges(edges.slice(i, i + UPSERT_BATCH));
        }

        // Vector upsert — split into small batches to avoid API limits
        if (!opts.skipVector) {
          for (let i = 0; i < nodes.length; i += EMBED_BATCH_SIZE) {
            const chunk = nodes.slice(i, i + EMBED_BATCH_SIZE);
            await upsertVectors(vectorIndex, embeddingProvider, chunk);
          }
        }

        // Lexical index
        if (!opts.skipLexical) {
          await lexicalRetriever.indexPassages(corpusId, passages);
        }

        // Accumulate for memory snapshot
        allFacts.push(...facts);
        allPassages.push(...passages);
        indexed++;
        uncommittedDocs++;
      } catch (err) {
        failed++;
        console.error(`[agdb-ingest-parallel] ✗ ${documentId}: ${err.message}`);
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const done = opts.startFrom + batchStart + batch.length;
    const totalDone = opts.startFrom + indexed;
    const rate = (indexed / Math.max(elapsed / 60, 0.01)).toFixed(1);
    console.log(`[agdb-ingest-parallel] [${done}/${opts.startFrom + mdFiles.length}] ${totalDone} ok, ${failed} err | ${elapsed}s | ${rate} docs/min`);

    // Checkpoint every CHECKPOINT_INTERVAL documents
    if (uncommittedDocs >= CHECKPOINT_INTERVAL) {
      const cpStart = Date.now();
      if (!opts.noBatch) {
        console.log(`[agdb-ingest-parallel] Checkpoint at ${totalDone} docs (persisting)...`);
        await client.request('batch_commit');
        const cpTime = ((Date.now() - cpStart) / 1000).toFixed(1);
        console.log(`[agdb-ingest-parallel] Checkpoint persisted in ${cpTime}s`);
        await client.request('batch_begin');
      }
      uncommittedDocs = 0;
    }
  }

  // Final commit
  console.log(`[agdb-ingest-parallel] Final commit...`);
  if (!opts.noBatch) {
    await client.request('batch_commit');
  }

  // ─── Phase 2: Save memory snapshot (single write) ──────────────────────────
  console.log(`[agdb-ingest-parallel] Saving memory snapshot (${allFacts.length} facts, ${allPassages.length} passages)...`);
  const snapshot = {
    corpusId,
    exportedAt: new Date().toISOString(),
    schemaVersion: 0,
    schemas: [],
    facts: allFacts,
    passages: allPassages,
  };
  await memoryStore.save(snapshot);

  // Summary
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log(`\n[agdb-ingest-parallel] Complete: ${indexed}/${mdFiles.length} indexed, ${failed} failed`);
  console.log(`[agdb-ingest-parallel] Time: ${totalTime}s (${(totalTime / Math.max(indexed, 1)).toFixed(1)}s/doc)`);
  console.log(`[agdb-ingest-parallel] Graph: ${allFacts.length} facts, ${allPassages.length} passages`);

  await client.close();
  releaseLock(lockPath);
}

main().catch(err => { console.error(err); process.exit(1); });
