#!/usr/bin/env node
/**
 * Sync vectors from CachedFileVectorIndex to aira-graphdb.
 *
 * Reads manifest.json + vectors.f32 + metadata.jsonl from the CachedFile format
 * and upserts missing vectors into aira-graphdb via vector_upsert RPC.
 *
 * Usage:
 *   node scripts/sync-vectors-to-agdb.mjs [--dry-run] [--namespace passage|fact|schema|entity]
 */
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

const BENCHMARK_DIR = resolve(process.cwd(), 'data/benchmark/hotpotqa');
const CORPUS_ID = 'fc0213c5-678c-4a79-aef9-c253b5f00c3d';
const VECTORS_DIR = resolve(BENCHMARK_DIR, 'vectors', CORPUS_ID);
const AGDB_PATH = resolve(BENCHMARK_DIR, 'hotpotqa.agdb');
const BATCH_SIZE = 200; // vectors per upsert RPC call (batch_mode skips per-upsert persist)

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force'); // Re-sync even if IDs exist
const NS_FILTER = (() => {
  const idx = process.argv.indexOf('--namespace');
  return idx >= 0 ? process.argv[idx + 1] : null;
})();

const NAMESPACES = NS_FILTER ? [NS_FILTER] : ['passage', 'fact', 'schema', 'entity'];

// Import aira-graphdb client
const { AiraGraphDbNativeClient } = await import('../dist/infrastructure/index.js');

function readCachedFileNamespace(namespace) {
  const nsDir = resolve(VECTORS_DIR, namespace);
  if (!existsSync(nsDir)) return { entries: [], vectorBuffer: null, metadataMap: new Map() };

  const manifestPath = resolve(nsDir, 'manifest.json');
  if (!existsSync(manifestPath)) return { entries: [], vectorBuffer: null, metadataMap: new Map() };

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const activeEntries = manifest.entries.filter(e => !e.deleted);

  const vectorsPath = resolve(nsDir, 'vectors.f32');
  const vectorBuffer = existsSync(vectorsPath) ? readFileSync(vectorsPath) : null;

  const metadataPath = resolve(nsDir, 'metadata.jsonl');
  const metadataMap = new Map();
  if (existsSync(metadataPath)) {
    const lines = readFileSync(metadataPath, 'utf-8').trim().split('\n');
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        metadataMap.set(parsed.id, parsed);
      } catch { /* skip */ }
    }
  }

  return { entries: activeEntries, vectorBuffer, metadataMap };
}

function extractVector(vectorBuffer, entry) {
  const startByte = entry.offset * 4;
  const endByte = startByte + entry.dimensions * 4;
  if (endByte > vectorBuffer.byteLength) return null;

  const buf = vectorBuffer.subarray(startByte, endByte);
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, entry.dimensions);
  // Convert f32 to f64 array for aira-graphdb
  return Array.from(f32);
}

async function getExistingIds(client, namespace) {
  // Do a dummy search to see if vectors exist, but we need the actual IDs
  // Use a large topK search with threshold 0 to get all vectors
  const dummyVec = new Array(3072).fill(0);
  dummyVec[0] = 1;

  try {
    const hits = await client.request('vector_search', {
      corpusId: CORPUS_ID,
      namespace,
      queryVector: dummyVec,
      topK: 200000,
      threshold: 0,
    });
    return new Set(hits.map(h => h.id));
  } catch (e) {
    console.warn(`  Warning: could not get existing IDs for ${namespace}: ${e.message}`);
    return new Set();
  }
}

async function syncNamespace(client, namespace) {
  console.log(`\n=== Syncing namespace: ${namespace} ===`);

  const { entries, vectorBuffer, metadataMap } = readCachedFileNamespace(namespace);
  if (!vectorBuffer || entries.length === 0) {
    console.log(`  No vectors found in CachedFile for ${namespace}`);
    return { total: 0, synced: 0, skipped: 0 };
  }

  console.log(`  CachedFile: ${entries.length} vectors`);

  // Get existing IDs in aira-graphdb
  console.log('  Fetching existing IDs from aira-graphdb...');
  const existingIds = await getExistingIds(client, namespace);
  console.log(`  aira-graphdb: ${existingIds.size} existing vectors`);

  // Find missing entries (or all entries if --force)
  const missingEntries = FORCE ? entries : entries.filter(e => !existingIds.has(e.id));
  console.log(`  To sync: ${missingEntries.length} vectors${FORCE ? ' (force mode)' : ''}`);

  if (missingEntries.length === 0) {
    return { total: entries.length, synced: 0, skipped: entries.length };
  }

  if (DRY_RUN) {
    console.log('  [DRY RUN] Would sync', missingEntries.length, 'vectors');
    return { total: entries.length, synced: 0, skipped: existingIds.size };
  }

  // Enable batch mode to skip per-upsert persist
  await client.request('batch_begin');

  // Upsert in batches
  let synced = 0;
  for (let i = 0; i < missingEntries.length; i += BATCH_SIZE) {
    const batch = missingEntries.slice(i, i + BATCH_SIZE);
    const records = [];

    for (const entry of batch) {
      const vector = extractVector(vectorBuffer, entry);
      if (!vector) continue;

      const metadata = metadataMap.get(entry.id) || {};
      records.push({
        id: entry.id,
        corpusId: CORPUS_ID,
        namespace,
        values: vector,
        metadata,
      });
    }

    if (records.length > 0) {
      await client.request('vector_upsert', { records });
      synced += records.length;
    }

    if ((i + BATCH_SIZE) % 500 === 0 || i + BATCH_SIZE >= missingEntries.length) {
      console.log(`  Progress: ${Math.min(synced, missingEntries.length)}/${missingEntries.length}`);
    }
  }

  // Commit batch (triggers single persist)
  console.log('  Committing batch (single persist)...');
  await client.request('batch_commit');

  console.log(`  Synced: ${synced} vectors`);
  return { total: entries.length, synced, skipped: existingIds.size };
}

async function main() {
  console.log('=== Vector Sync: CachedFileVectorIndex → aira-graphdb ===');
  console.log(`  Source: ${VECTORS_DIR}`);
  console.log(`  Target: ${AGDB_PATH}`);
  console.log(`  Corpus: ${CORPUS_ID}`);
  console.log(`  Namespaces: ${NAMESPACES.join(', ')}`);
  if (DRY_RUN) console.log('  Mode: DRY RUN');

  const client = new AiraGraphDbNativeClient(AGDB_PATH);
  await client.request('ping');
  console.log('  Connected to aira-graphdb');

  const results = {};
  for (const ns of NAMESPACES) {
    results[ns] = await syncNamespace(client, ns);
  }

  // aira-graphdb auto-persists after each vector_upsert (persist_if_needed)
  // No explicit persist RPC needed
  console.log('\n  Auto-persisted by aira-graphdb after each upsert batch.');

  // Summary
  console.log('\n=== Summary ===');
  let totalSynced = 0;
  for (const [ns, r] of Object.entries(results)) {
    console.log(`  ${ns}: ${r.synced} synced / ${r.total} total (${r.skipped} already existed)`);
    totalSynced += r.synced;
  }
  console.log(`  Total synced: ${totalSynced}`);

  client.close();
}

main().catch(e => { console.error(e); process.exit(1); });
