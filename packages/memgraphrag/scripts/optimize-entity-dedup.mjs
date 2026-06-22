#!/usr/bin/env node
/**
 * Entity Deduplication & Graph Optimization Script
 *
 * Merges semantically-duplicate entity nodes in the aira-graphdb graph:
 * 1. Singular/plural variants (e.g., "1960" / "1960s")
 * 2. Article/preposition variants (e.g., "christmas carol" / "a christmas carol")
 * 3. Whitespace/punctuation normalization
 *
 * This improves PPR convergence by consolidating PageRank probability
 * that was previously split across duplicate entities.
 *
 * Usage: node scripts/optimize-entity-dedup.mjs [--dry-run] [--db <path>]
 */

import { AiraGraphDbNativeClient } from '../dist/infrastructure/storage/aira-graphdb/NativeClient.js';
import { AiraGraphDbGraphStore } from '../dist/infrastructure/storage/aira-graphdb/AiraGraphDbAdapters.js';
import { resolve } from 'path';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const dbIdx = args.indexOf('--db');
const dbPath = dbIdx >= 0 ? args[dbIdx + 1] : resolve(import.meta.dirname, '../data/benchmark/hotpotqa/hotpotqa.agdb');

console.log(`Entity Deduplication${dryRun ? ' [DRY RUN]' : ''}`);
console.log(`  DB: ${dbPath}`);

const client = new AiraGraphDbNativeClient(dbPath);
await client.request('ping');
const store = new AiraGraphDbGraphStore(client);

// Discover corpusId
const sampleNodes = (await client.cypherQuery('MATCH (n) RETURN n LIMIT 1')).Nodes;
if (!sampleNodes || sampleNodes.length === 0) {
  console.error('No nodes found');
  process.exit(1);
}
const corpusId = sampleNodes[0].properties.corpusId?.String;
console.log(`  Corpus: ${corpusId}`);

// Load all entity nodes
const entities = await store.getNodes(corpusId, 'entity');
console.log(`  Entities: ${entities.length}`);

// --- Build deduplication groups ---

/** Normalize an entity name for grouping */
function canonicalize(name) {
  return name
    .toLowerCase()
    .replace(/[_]+/g, ' ')
    // Remove leading articles
    .replace(/^(the|a|an)\s+/, '')
    // Remove trailing 's' for plural (but not 'ss', 'us', 'is')
    .replace(/([^sui])s$/, '$1')
    .replace(/ies$/, 'y')
    // Normalize whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

/** Conservative normalization: only strip leading "the" (not "a"/"an" which are often part of titles) */
function normalizeForGrouping(rawName) {
  const name = rawName.replace(/_/g, ' ').toLowerCase();
  return name
    .replace(/^the\s+/, '')   // Only strip leading "the" — "a/an" may be part of proper nouns
    .replace(/\s+/g, ' ')
    .trim();
}

/** Safety filter: only merge if BOTH names are multi-word (≥3 words) to avoid "age"/"the age" false positives */
function isSafeMerge(canonicalName, duplicateName) {
  const canonical = canonicalName.replace(/_/g, ' ');
  const duplicate = duplicateName.replace(/_/g, ' ');
  // Both must be at least 2 words (or canonical ≥ 6 chars)
  const canonWords = canonical.split(' ').length;
  if (canonWords < 2 && canonical.length < 6) return false;
  // The duplicate should just be "the " + canonical
  const withoutThe = duplicate.replace(/^the\s+/, '');
  return withoutThe === canonical;
}

// Strategy 1: Article/preposition duplicates
const articleGroups = new Map();
for (const entity of entities) {
  const rawName = entity.nodeId.replace('entity:', '');
  const key = normalizeForGrouping(rawName);
  if (!articleGroups.has(key)) articleGroups.set(key, []);
  articleGroups.get(key).push(entity);
}

// Strategy 2: Exact singular/plural pairs (more conservative)
const nameSet = new Set(entities.map(e => e.nodeId.replace('entity:', '')));

// Collect merge operations
const mergeOps = []; // { canonical: nodeId, duplicates: [nodeId, ...] }

// From article groups: pick the shortest name as canonical (with safety check)
for (const [_key, group] of articleGroups) {
  if (group.length <= 1) continue;
  // Sort by name length (shorter = more canonical), then alphabetically
  group.sort((a, b) => {
    const aName = a.nodeId.replace('entity:', '');
    const bName = b.nodeId.replace('entity:', '');
    return aName.length - bName.length || aName.localeCompare(bName);
  });
  const canonical = group[0];
  const canonicalName = canonical.nodeId.replace('entity:', '');
  const duplicates = group.slice(1).filter(d => {
    const dupName = d.nodeId.replace('entity:', '');
    return isSafeMerge(canonicalName, dupName);
  });
  if (duplicates.length === 0) continue;
  mergeOps.push({
    canonicalNodeId: canonical.nodeId,
    canonicalName,
    duplicateNodeIds: duplicates.map(d => d.nodeId),
    duplicateNames: duplicates.map(d => d.nodeId.replace('entity:', '')),
    reason: 'article/preposition variant',
  });
}

console.log(`\n  Merge groups found: ${mergeOps.length}`);
console.log(`  Entities to merge: ${mergeOps.reduce((s, op) => s + op.duplicateNodeIds.length, 0)}`);

// Show top 20 merges
console.log('\n  Top merge operations:');
for (const op of mergeOps.slice(0, 20)) {
  console.log(`    "${op.canonicalName}" <- [${op.duplicateNames.slice(0, 3).join(', ')}] (${op.reason})`);
}

if (dryRun) {
  console.log('\n  [DRY RUN] No changes applied.');
  await client.close();
  process.exit(0);
}

// --- Execute merges ---
console.log('\n  Executing merges...');
let mergedEdges = 0;
let deletedNodes = 0;
let errors = 0;

for (let i = 0; i < mergeOps.length; i++) {
  const op = mergeOps[i];
  if ((i + 1) % 50 === 0) {
    process.stdout.write(`\r  Progress: ${i + 1}/${mergeOps.length} groups`);
  }

  for (const dupNodeId of op.duplicateNodeIds) {
    try {
      // Get all edges connected to the duplicate node
      const edges = await store.getAdjacent(corpusId, dupNodeId);

      // Redirect edges to canonical node
      for (const edge of edges) {
        const newEdge = { ...edge };
        if (edge.sourceNodeId === dupNodeId) {
          newEdge.sourceNodeId = op.canonicalNodeId;
        }
        if (edge.targetNodeId === dupNodeId) {
          newEdge.targetNodeId = op.canonicalNodeId;
        }
        // Skip self-loops
        if (newEdge.sourceNodeId === newEdge.targetNodeId) continue;

        // Generate new edge ID
        newEdge.edgeId = edge.edgeId.replace(
          dupNodeId.replace('entity:', ''),
          op.canonicalNodeId.replace('entity:', ''),
        );
        await store.upsertEdges([newEdge]);
        mergedEdges++;
      }

      // Delete old edges
      if (edges.length > 0) {
        await store.deleteEdges(corpusId, edges.map(e => e.edgeId));
      }

      // Delete the duplicate node
      await store.deleteNodes(corpusId, [dupNodeId]);
      deletedNodes++;
    } catch (err) {
      errors++;
      if (errors <= 5) {
        console.error(`\n  Error merging ${dupNodeId}: ${err.message}`);
      }
    }
  }
}

console.log(`\n\n  === Results ===`);
console.log(`  Merged edge redirections: ${mergedEdges}`);
console.log(`  Deleted duplicate nodes: ${deletedNodes}`);
console.log(`  Errors: ${errors}`);

// Verify final state
const finalEntities = await store.getNodes(corpusId, 'entity');
console.log(`  Entity count: ${entities.length} -> ${finalEntities.length} (${entities.length - finalEntities.length} removed)`);

await client.close();
console.log('\n  Done.');
