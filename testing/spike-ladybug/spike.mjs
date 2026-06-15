/**
 * T-00 Spike: Verify PROJECT_GRAPH + QUERY_VECTOR_INDEX interop in LadybugDB
 *
 * Tests:
 * 1. Basic HNSW vector index creation and query
 * 2. PROJECT_GRAPH + QUERY_VECTOR_INDEX (multi-corpus scenario)
 * 3. Over-fetch recall with skewed corpus distribution (90:10)
 */

import ladybugdb from '@ladybugdb/core';
const { Database, Connection } = ladybugdb;

const DB_PATH = './spike-test-db';
const VECTOR_DIM = 8; // small dim for spike
const TOTAL_VECTORS = 200;
const CORPUS_A_SIZE = 180; // 90%
const CORPUS_B_SIZE = 20;  // 10%

function randomVector(dim) {
  const v = new Array(dim);
  for (let i = 0; i < dim; i++) v[i] = Math.random();
  // normalize
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map(x => x / norm);
}

function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function cleanup() {
  const fs = await import('fs');
  try { fs.rmSync(DB_PATH, { recursive: true, force: true }); } catch {}
}

async function main() {
  await cleanup();

  console.log('=== T-00 Spike: LadybugDB PROJECT_GRAPH + HNSW ===\n');

  // 1. Create database and load extensions
  const db = new Database(DB_PATH);
  const conn = new Connection(db);

  console.log('1. Loading extensions...');
  await conn.query('INSTALL vector; LOAD vector;');
  await conn.query('INSTALL fts; LOAD fts;');
  await conn.query('INSTALL algo; LOAD algo;');
  console.log('   ✓ Extensions loaded\n');

  // 2. Create schema
  console.log('2. Creating schema...');
  await conn.query(`
    CREATE NODE TABLE VectorNode(
      id STRING PRIMARY KEY,
      corpus_id STRING,
      vec FLOAT[${VECTOR_DIM}],
      label STRING
    )
  `);
  // Need a dummy edge table for PROJECT_GRAPH
  await conn.query(`
    CREATE REL TABLE LINKS(FROM VectorNode TO VectorNode, weight FLOAT)
  `);
  console.log('   ✓ Schema created\n');

  // 3. Insert vectors with corpus assignment
  console.log(`3. Inserting ${TOTAL_VECTORS} vectors (corpus_a: ${CORPUS_A_SIZE}, corpus_b: ${CORPUS_B_SIZE})...`);
  const allVectors = [];
  for (let i = 0; i < TOTAL_VECTORS; i++) {
    const corpusId = i < CORPUS_A_SIZE ? 'corpus_a' : 'corpus_b';
    const vec = randomVector(VECTOR_DIM);
    allVectors.push({ id: `${corpusId}:node_${i}`, corpusId, vec });
    await conn.query(
      `CREATE (n:VectorNode {id: $id, corpus_id: $cid, vec: $vec, label: $lbl})`,
      { id: `${corpusId}:node_${i}`, cid: corpusId, vec, lbl: `label_${i}` }
    );
  }
  // Add some edges so PROJECT_GRAPH has something to work with
  for (let i = 0; i < 50; i++) {
    const src = `corpus_a:node_${i}`;
    const tgt = `corpus_a:node_${i + 1}`;
    await conn.query(
      `MATCH (a:VectorNode {id: $src}), (b:VectorNode {id: $tgt}) CREATE (a)-[:LINKS {weight: 1.0}]->(b)`,
      { src, tgt }
    );
  }
  console.log('   ✓ Vectors and edges inserted\n');

  // 4. Create HNSW index
  console.log('4. Creating HNSW index...');
  await conn.query(`
    CREATE VECTOR INDEX vec_idx ON VectorNode(vec)
    OPTIONS (metric = 'cosine', m = 16, ef_construction = 200)
  `);
  console.log('   ✓ HNSW index created\n');

  // 5. Test basic QUERY_VECTOR_INDEX (global)
  console.log('5. Testing basic QUERY_VECTOR_INDEX (global)...');
  const queryVec = randomVector(VECTOR_DIM);
  const globalResult = await conn.query(
    `CALL QUERY_VECTOR_INDEX('VectorNode', 'vec_idx', $vec, 10)
     RETURN node, distance`,
    { vec: queryVec }
  );
  const globalRows = await globalResult.getAll();
  console.log(`   ✓ Global search returned ${globalRows.length} results`);
  console.log(`   Top 3: ${globalRows.slice(0, 3).map(r => `${r.node.id} (dist=${r.distance.toFixed(4)})`).join(', ')}\n`);

  // 6. Test PROJECT_GRAPH + QUERY_VECTOR_INDEX
  console.log('6. Testing PROJECT_GRAPH + QUERY_VECTOR_INDEX...');
  let projGraphWorks = false;
  try {
    await conn.query(`
      PROJECT GRAPH corpus_b_proj {
        NODE TABLE VectorNode WHERE corpus_id = 'corpus_b',
        REL TABLE LINKS
      }
    `);
    console.log('   ✓ PROJECT_GRAPH created for corpus_b');

    try {
      const projResult = await conn.query(
        `CALL QUERY_VECTOR_INDEX('corpus_b_proj', 'vec_idx', $vec, 10)
         RETURN node, distance`,
        { vec: queryVec }
      );
      const projRows = await projResult.getAll();
      console.log(`   ✓ PROJECT_GRAPH + QUERY_VECTOR_INDEX works! Returned ${projRows.length} results`);
      const allCorpusB = projRows.every(r => r.node.corpus_id === 'corpus_b');
      console.log(`   All results from corpus_b: ${allCorpusB ? '✓ YES' : '✗ NO'}`);
      projGraphWorks = true;
    } catch (e) {
      console.log(`   ✗ QUERY_VECTOR_INDEX on projected graph FAILED: ${e.message}`);
    }
  } catch (e) {
    console.log(`   ✗ PROJECT_GRAPH FAILED: ${e.message}`);
  }

  // 7. Test fallback: global HNSW + corpus_id filter + over-fetch
  console.log('\n7. Testing over-fetch fallback strategy...');
  const TOP_K = 5;
  const OVER_FETCH_MULTIPLIER = 3;

  // Ground truth: exact cosine search on corpus_b only
  const corpusBVectors = allVectors.filter(v => v.corpusId === 'corpus_b');
  const exactScores = corpusBVectors
    .map(v => ({ id: v.id, score: cosineSimilarity(queryVec, v.vec) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K);

  // Over-fetch from global HNSW, then filter
  const overFetchResult = await conn.query(
    `CALL QUERY_VECTOR_INDEX('VectorNode', 'vec_idx', $vec, $k)
     RETURN node.id AS id, node.corpus_id AS corpus_id, distance
     ORDER BY distance`,
    { vec: queryVec, k: TOP_K * OVER_FETCH_MULTIPLIER }
  );
  const overFetchRows = await overFetchResult.getAll();
  const filteredResults = overFetchRows
    .filter(r => r.corpus_id === 'corpus_b')
    .slice(0, TOP_K)
    .map(r => ({ id: r.id, score: 1 - r.distance }));

  // Calculate recall
  const exactIds = new Set(exactScores.map(s => s.id));
  const retrievedIds = new Set(filteredResults.map(s => s.id));
  const overlap = [...exactIds].filter(id => retrievedIds.has(id)).length;
  const recall = overlap / exactIds.size;

  console.log(`   Exact top-${TOP_K} for corpus_b: ${exactScores.map(s => s.id).join(', ')}`);
  console.log(`   Over-fetch (×${OVER_FETCH_MULTIPLIER}) filtered: ${filteredResults.map(s => s.id).join(', ')}`);
  console.log(`   Recall: ${overlap}/${exactIds.size} = ${(recall * 100).toFixed(1)}%`);

  // Test with larger over-fetch for skewed data
  console.log('\n   Testing with higher over-fetch for 90:10 skew...');
  for (const mult of [3, 5, 10, 20]) {
    const ofResult = await conn.query(
      `CALL QUERY_VECTOR_INDEX('VectorNode', 'vec_idx', $vec, $k)
       RETURN node.id AS id, node.corpus_id AS corpus_id, distance
       ORDER BY distance`,
      { vec: queryVec, k: TOP_K * mult }
    );
    const ofRows = await ofResult.getAll();
    const filtered = ofRows.filter(r => r.corpus_id === 'corpus_b').slice(0, TOP_K);
    const filteredSet = new Set(filtered.map(r => r.id));
    const rec = [...exactIds].filter(id => filteredSet.has(id)).length / exactIds.size;
    console.log(`   ×${mult} over-fetch: retrieved ${filtered.length}/${TOP_K}, recall=${(rec * 100).toFixed(1)}%`);
  }

  // 8. Summary
  console.log('\n=== SPIKE RESULTS ===');
  console.log(`PROJECT_GRAPH + QUERY_VECTOR_INDEX: ${projGraphWorks ? 'GO ✓' : 'NO-GO ✗ (use over-fetch fallback)'}`);
  console.log(`Over-fetch fallback recall (×3): ${(recall * 100).toFixed(1)}%`);
  console.log(`Threshold: recall ≥ 95%`);
  console.log(`ADR-002 Decision: ${projGraphWorks ? 'Use PROJECT_GRAPH for multi-corpus' : 'Use global HNSW + over-fetch (verify ×multiplier for target recall)'}`);

  // Cleanup
  db.close();
  await cleanup();

  console.log('\n=== SPIKE COMPLETE ===');
}

main().catch(e => {
  console.error('Spike failed:', e);
  process.exit(1);
});
