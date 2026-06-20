#!/usr/bin/env node
/**
 * Migrate graph data from SQLite to Neo4j.
 * Reads nodes and edges from SQLite graph_nodes/graph_edges tables
 * and writes them to Neo4j using batch UNWIND operations.
 *
 * Usage:
 *   node scripts/migrate-sqlite-to-neo4j.mjs [--sqlite <path>] [--corpus <id>]
 *
 * Environment:
 *   NEO4J_URI, NEO4J_USER, NEO4J_PASS, NEO4J_DB
 */
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { Neo4jConnectionPool } from '../dist/infrastructure/storage/neo4j/Neo4jConnection.js';
import { Neo4jMemoryStore } from '../dist/infrastructure/storage/neo4j/Neo4jMemoryStore.js';
import { Neo4jGraphStore } from '../dist/infrastructure/storage/neo4j/Neo4jGraphStore.js';

const REPO_ROOT = resolve(process.cwd(), '../..');

// Parse args
const args = process.argv.slice(2);
let sqlitePath = resolve(REPO_ROOT, 'data/benchmark/hotpotqa/hotpotqa.sqlite');
let corpusId = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--sqlite') sqlitePath = resolve(args[++i]);
  if (args[i] === '--corpus') corpusId = args[++i];
}

// Auto-detect corpus ID
if (!corpusId) {
  const cidFile = resolve(sqlitePath, '..', 'corpus_id.txt');
  try {
    corpusId = readFileSync(cidFile, 'utf-8').trim();
  } catch {
    console.error('Cannot detect corpus ID. Use --corpus <id>');
    process.exit(1);
  }
}

console.log(`SQLite: ${sqlitePath}`);
console.log(`Corpus: ${corpusId}`);

// Open SQLite
const db = new Database(sqlitePath, { readonly: true });

// Connect Neo4j
const pool = new Neo4jConnectionPool({
  uri: process.env.NEO4J_URI || 'bolt://localhost:7687',
  username: process.env.NEO4J_USER || 'neo4j',
  password: process.env.NEO4J_PASS || 'memgraphrag',
  database: process.env.NEO4J_DB || 'neo4j',
});
await pool.init();
console.log('Connected to Neo4j');

// Check if data already exists
const existingCount = await pool.execute(
  'MATCH (n:GNode) WHERE n.corpus_id = $cid RETURN count(n) AS c',
  { cid: corpusId },
);
const existingNodes = existingCount.records[0]?.get('c')?.toNumber?.() ?? 0;
if (existingNodes > 0) {
  console.log(`Neo4j already has ${existingNodes} nodes for this corpus. Skipping migration.`);
  await pool.close();
  db.close();
  process.exit(0);
}

// --- Migrate Memory (schemas, facts, passages) ---
const memoryStore = new Neo4jMemoryStore(pool);
const BATCH = 500;

// Schemas — build domain objects from normalized SQLite columns
const schemaRows = db.prepare(`
  SELECT schema_id, corpus_id, head_type, relation, tail_type, canonical_key,
         frequency, state, stabilization_threshold, version, created_at, updated_at
  FROM schemas WHERE corpus_id = ?
`).all(corpusId);
console.log(`Migrating ${schemaRows.length} schemas...`);

// Also need source_document_ids and aliases from junction tables (if they exist)
let schemaDocStmt, schemaAliasStmt;
try { schemaDocStmt = db.prepare('SELECT document_id FROM schema_source_documents WHERE schema_id = ?'); } catch { schemaDocStmt = null; }
try { schemaAliasStmt = db.prepare('SELECT alias FROM schema_aliases WHERE schema_id = ?'); } catch { schemaAliasStmt = null; }

for (let i = 0; i < schemaRows.length; i += BATCH) {
  const batch = schemaRows.slice(i, i + BATCH).map(r => ({
    schemaId: r.schema_id,
    corpusId: r.corpus_id,
    headType: r.head_type,
    relation: r.relation,
    tailType: r.tail_type,
    canonicalKey: r.canonical_key,
    frequency: r.frequency,
    state: r.state,
    stabilizationThreshold: r.stabilization_threshold,
    version: r.version,
    sourceDocumentIds: schemaDocStmt ? schemaDocStmt.all(r.schema_id).map(d => d.document_id) : [],
    aliases: schemaAliasStmt ? schemaAliasStmt.all(r.schema_id).map(a => a.alias) : [],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
  await memoryStore.save({ corpusId, exportedAt: new Date().toISOString(), schemas: batch, facts: [], passages: [], schemaVersion: 1 });
  if ((i + BATCH) % 2000 === 0 || i + BATCH >= schemaRows.length) {
    console.log(`  Schemas: ${Math.min(i + BATCH, schemaRows.length)}/${schemaRows.length}`);
  }
}

// Facts — need passage_ids from junction table
const factCount = db.prepare('SELECT COUNT(*) as c FROM facts WHERE corpus_id = ?').get(corpusId).c;
console.log(`Migrating ${factCount} facts...`);
const factStmt = db.prepare(`
  SELECT fact_id, corpus_id, schema_id, head_entity, head_type, relation,
         tail_entity, tail_type, state, confidence, created_at, updated_at
  FROM facts WHERE corpus_id = ? LIMIT ? OFFSET ?
`);
let factPassageStmt, factDocStmt;
try { factPassageStmt = db.prepare('SELECT passage_id FROM fact_passages WHERE fact_id = ?'); } catch { factPassageStmt = null; }
try { factDocStmt = db.prepare('SELECT document_id FROM fact_source_documents WHERE fact_id = ?'); } catch { factDocStmt = null; }

for (let offset = 0; offset < factCount; offset += BATCH) {
  const rows = factStmt.all(corpusId, BATCH, offset);
  const facts = rows.map(r => ({
    factId: r.fact_id,
    corpusId: r.corpus_id,
    schemaId: r.schema_id,
    headEntity: r.head_entity,
    headType: r.head_type,
    relation: r.relation,
    tailEntity: r.tail_entity,
    tailType: r.tail_type,
    state: r.state,
    passageIds: factPassageStmt ? factPassageStmt.all(r.fact_id).map(p => p.passage_id) : [],
    sourceDocumentIds: factDocStmt ? factDocStmt.all(r.fact_id).map(d => d.document_id) : [],
    confidence: r.confidence,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
  await memoryStore.save({ corpusId, exportedAt: new Date().toISOString(), schemas: [], facts, passages: [], schemaVersion: 1 });
  if ((offset + BATCH) % 5000 === 0 || offset + BATCH >= factCount) {
    console.log(`  Facts: ${Math.min(offset + BATCH, factCount)}/${factCount}`);
  }
}

// Passages
const passageCount = db.prepare('SELECT COUNT(*) as c FROM passages WHERE corpus_id = ?').get(corpusId).c;
console.log(`Migrating ${passageCount} passages...`);
const passageStmt = db.prepare(`
  SELECT passage_id, corpus_id, document_id, text, normalized_text, section_path,
         chunk_id, chunk_index, offset_start, offset_end, entity_mentions,
         quality_flags, quality_score, created_at, updated_at
  FROM passages WHERE corpus_id = ? LIMIT ? OFFSET ?
`);

// Get document metadata for passages
let docStmt;
try { docStmt = db.prepare('SELECT document_id, title, source_url, language FROM documents WHERE document_id = ?'); } catch { docStmt = null; }

for (let offset = 0; offset < passageCount; offset += BATCH) {
  const rows = passageStmt.all(corpusId, BATCH, offset);
  const passages = rows.map(r => {
    let docMeta = {};
    if (docStmt) {
      const doc = docStmt.get(r.document_id);
      if (doc) docMeta = { documentId: doc.document_id, title: doc.title, sourceUrl: doc.source_url, language: doc.language };
    }
    if (!docMeta.documentId) docMeta = { documentId: r.document_id, title: '', sourceUrl: '', language: 'en' };
    return {
      passageId: r.passage_id,
      corpusId: r.corpus_id,
      text: r.text,
      normalizedText: r.normalized_text,
      sectionPath: r.section_path,
      chunkId: r.chunk_id,
      chunkIndex: r.chunk_index,
      offsetStart: r.offset_start,
      offsetEnd: r.offset_end,
      entityMentions: JSON.parse(r.entity_mentions || '[]'),
      qualityFlags: JSON.parse(r.quality_flags || '[]'),
      qualityScore: r.quality_score ?? 1.0,
      metadata: docMeta,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  });
  await memoryStore.save({ corpusId, exportedAt: new Date().toISOString(), schemas: [], facts: [], passages, schemaVersion: 1 });
  if ((offset + BATCH) % 5000 === 0 || offset + BATCH >= passageCount) {
    console.log(`  Passages: ${Math.min(offset + BATCH, passageCount)}/${passageCount}`);
  }
}

// --- Migrate Graph (nodes + edges) ---
const graphStore = new Neo4jGraphStore(pool);

// Nodes
const nodeCount = db.prepare('SELECT COUNT(*) as c FROM graph_nodes WHERE corpus_id = ?').get(corpusId).c;
console.log(`Migrating ${nodeCount} graph nodes...`);
const nodeStmt = db.prepare('SELECT node_id, corpus_id, layer, label, ref_id FROM graph_nodes WHERE corpus_id = ? LIMIT ? OFFSET ?');
for (let offset = 0; offset < nodeCount; offset += BATCH) {
  const rows = nodeStmt.all(corpusId, BATCH, offset);
  const nodes = rows.map(r => ({
    nodeId: r.node_id,
    corpusId: r.corpus_id,
    layer: r.layer,
    label: r.label || '',
    ref: { refId: r.ref_id },
  }));
  await graphStore.upsertNodes(nodes);
  if ((offset + BATCH) % 10000 === 0 || offset + BATCH >= nodeCount) {
    console.log(`  Nodes: ${Math.min(offset + BATCH, nodeCount)}/${nodeCount}`);
  }
}

// Edges
const edgeCount = db.prepare('SELECT COUNT(*) as c FROM graph_edges WHERE corpus_id = ?').get(corpusId).c;
console.log(`Migrating ${edgeCount} graph edges...`);
const edgeStmt = db.prepare('SELECT edge_id, corpus_id, source_node_id, target_node_id, relation, weight, bridge_kind FROM graph_edges WHERE corpus_id = ? LIMIT ? OFFSET ?');
for (let offset = 0; offset < edgeCount; offset += BATCH) {
  const rows = edgeStmt.all(corpusId, BATCH, offset);
  const edges = rows.map(r => ({
    edgeId: r.edge_id,
    corpusId: r.corpus_id,
    sourceNodeId: r.source_node_id,
    targetNodeId: r.target_node_id,
    relation: r.relation,
    weight: r.weight,
    bridgeKind: r.bridge_kind || undefined,
  }));
  try {
    await graphStore.upsertEdges(edges);
  } catch (err) {
    // Some edges may reference missing nodes — skip batch and try one-by-one
    console.warn(`  Edge batch at ${offset} failed, trying individually...`);
    let skipped = 0;
    for (const edge of edges) {
      try {
        await graphStore.upsertEdges([edge]);
      } catch {
        skipped++;
      }
    }
    if (skipped > 0) console.warn(`  Skipped ${skipped} edges with missing nodes`);
  }
  if ((offset + BATCH) % 10000 === 0 || offset + BATCH >= edgeCount) {
    console.log(`  Edges: ${Math.min(offset + BATCH, edgeCount)}/${edgeCount}`);
  }
}

// Verify
const verifyNodes = await pool.execute(
  'MATCH (n:GNode) WHERE n.corpus_id = $cid RETURN count(n) AS c',
  { cid: corpusId },
);
const verifyEdges = await pool.execute(
  'MATCH ()-[e:GEdge]->() WHERE e.corpus_id = $cid RETURN count(e) AS c',
  { cid: corpusId },
);
const verifyFacts = await pool.execute(
  'MATCH (n:FactNode) WHERE n.corpus_id = $cid RETURN count(n) AS c',
  { cid: corpusId },
);

console.log(`\nMigration complete:`);
console.log(`  GNodes: ${verifyNodes.records[0]?.get('c')?.toNumber?.()}`);
console.log(`  GEdges: ${verifyEdges.records[0]?.get('c')?.toNumber?.()}`);
console.log(`  FactNodes: ${verifyFacts.records[0]?.get('c')?.toNumber?.()}`);

await pool.close();
db.close();
console.log('Done!');
