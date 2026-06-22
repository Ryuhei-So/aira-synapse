/**
 * Migrate graph data from Neo4j to aira-graphdb native sidecar.
 *
 * Usage:
 *   node scripts/migrate-neo4j-to-agdb.mjs [--corpus <corpusId>]
 */
import { resolve } from 'node:path';
import { Neo4jConnectionPool } from '../dist/infrastructure/storage/neo4j/Neo4jConnection.js';
import { AiraGraphDbNativeClient } from '../dist/infrastructure/storage/aira-graphdb/NativeClient.js';

const CORPUS_ID = process.argv.includes('--corpus')
  ? process.argv[process.argv.indexOf('--corpus') + 1]
  : 'fc0213c5-678c-4a79-aef9-c253b5f00c3d'; // EN corpus

const AGDB_PATH = resolve(process.cwd(), 'data/benchmark/hotpotqa/hotpotqa.agdb');
const BATCH = 500;

async function main() {
  console.log(`Migrating corpus ${CORPUS_ID} from Neo4j → aira-graphdb`);
  console.log(`  Output: ${AGDB_PATH}`);

  // Connect to Neo4j
  const neo4j = new Neo4jConnectionPool({
    uri: process.env.NEO4J_URI || 'bolt://localhost:7687',
    username: process.env.NEO4J_USER || 'neo4j',
    password: process.env.NEO4J_PASS || 'memgraphrag',
    database: process.env.NEO4J_DB || 'neo4j',
  });
  await neo4j.init();

  // Start aira-graphdb sidecar
  const agdb = new AiraGraphDbNativeClient(AGDB_PATH);
  await agdb.request('ping');
  console.log('  aira-graphdb sidecar connected');

  // Check if already migrated
  const existingCount = await agdb.request('projection_get_node_count', { corpusId: CORPUS_ID });
  if (existingCount > 0) {
    console.log(`  Already has ${existingCount} nodes — skipping migration`);
    await agdb.close();
    await neo4j.close();
    return;
  }

  // 1. Migrate GNodes
  console.log('\n--- Migrating GNodes ---');
  const nodeResult = await neo4j.execute(
    'MATCH (n:GNode {corpus_id: $cid}) RETURN n.node_id AS nodeId, n.corpus_id AS corpusId, n.layer AS layer, n.label AS label, n.ref_json AS refJson',
    { cid: CORPUS_ID },
  );
  const allNodes = nodeResult.records.map(r => ({
    nodeId: r.get('nodeId'),
    corpusId: r.get('corpusId'),
    layer: r.get('layer'),
    label: r.get('label') || '',
    ref: JSON.parse(r.get('refJson') || '{}'),
  }));
  console.log(`  Total nodes: ${allNodes.length}`);

  for (let i = 0; i < allNodes.length; i += BATCH) {
    const batch = allNodes.slice(i, i + BATCH);
    await agdb.request('upsert_nodes', { nodes: batch });
    if ((i + BATCH) % 10000 === 0 || i + BATCH >= allNodes.length) {
      console.log(`  Upserted ${Math.min(i + BATCH, allNodes.length)}/${allNodes.length} nodes`);
    }
  }

  // 2. Migrate GEdges
  console.log('\n--- Migrating GEdges ---');
  const edgeResult = await neo4j.execute(
    'MATCH (s:GNode)-[e:GEdge {corpus_id: $cid}]->(t:GNode) RETURN e.edge_id AS edgeId, e.corpus_id AS corpusId, s.node_id AS sourceNodeId, t.node_id AS targetNodeId, e.relation AS relation, e.weight AS weight, e.bridge_kind AS bridgeKind',
    { cid: CORPUS_ID },
  );
  const allEdges = edgeResult.records.map(r => {
    const weight = r.get('weight');
    return {
      edgeId: r.get('edgeId'),
      corpusId: r.get('corpusId'),
      sourceNodeId: r.get('sourceNodeId'),
      targetNodeId: r.get('targetNodeId'),
      relation: r.get('relation') || '',
      weight: typeof weight === 'object' && weight !== null && 'toNumber' in weight
        ? weight.toNumber() : (typeof weight === 'number' ? weight : 1.0),
      bridgeKind: r.get('bridgeKind') || null,
    };
  });
  console.log(`  Total edges: ${allEdges.length}`);

  for (let i = 0; i < allEdges.length; i += BATCH) {
    const batch = allEdges.slice(i, i + BATCH);
    await agdb.request('upsert_edges', { edges: batch });
    if ((i + BATCH) % 10000 === 0 || i + BATCH >= allEdges.length) {
      console.log(`  Upserted ${Math.min(i + BATCH, allEdges.length)}/${allEdges.length} edges`);
    }
  }

  // 3. Verify
  const finalCount = await agdb.request('projection_get_node_count', { corpusId: CORPUS_ID });
  console.log(`\n✅ Migration complete: ${finalCount} nodes in aira-graphdb`);

  await agdb.close();
  await neo4j.close();
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
