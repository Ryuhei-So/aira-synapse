/**
 * T-00 Spike: Over-fetch recall test with skewed corpus (90:10)
 * 
 * ADR-002 Decision: NO-GO for PROJECT_GRAPH + QUERY_VECTOR_INDEX
 * → Fallback: global HNSW + over-fetch + application-level corpus_id filter
 */

import ldb from '@ladybugdb/core';

const VECTOR_DIM = 32;
const TOTAL = 1000;
const CORPUS_A = 900; // 90%
const CORPUS_B = 100; // 10%
const TOP_K = 10;

function randomVector(dim) {
  const v = new Array(dim);
  for (let i = 0; i < dim; i++) v[i] = Math.random() - 0.5;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map(x => x / norm);
}

function cosineDistance(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return 1 - dot; // vectors are normalized, so this is cosine distance
}

async function main() {
  console.log('=== T-00 Spike: Over-fetch Recall Test ===\n');
  console.log(`Corpus distribution: A=${CORPUS_A} (${(CORPUS_A/TOTAL*100).toFixed(0)}%), B=${CORPUS_B} (${(CORPUS_B/TOTAL*100).toFixed(0)}%)`);
  console.log(`Vector dim: ${VECTOR_DIM}, Total: ${TOTAL}, Top-K: ${TOP_K}\n`);

  const db = new ldb.Database(':memory:');
  const conn = new ldb.Connection(db);
  await conn.query('INSTALL vector; LOAD vector;');
  await conn.query(`CREATE NODE TABLE VN(id STRING PRIMARY KEY, corpus_id STRING, vec FLOAT[${VECTOR_DIM}])`);

  // Generate and insert vectors
  const vectors = [];
  const ps = await conn.prepare('CREATE (n:VN {id: $id, corpus_id: $cid, vec: $vec})');
  for (let i = 0; i < TOTAL; i++) {
    const cid = i < CORPUS_A ? 'a' : 'b';
    const vec = randomVector(VECTOR_DIM);
    vectors.push({ id: `${cid}:${i}`, cid, vec });
    await conn.execute(ps, { id: `${cid}:${i}`, cid, vec });
  }
  console.log(`Inserted ${TOTAL} vectors`);

  // Create HNSW index
  await conn.query('CALL CREATE_VECTOR_INDEX("VN", "vi", "vec")');
  console.log('HNSW index created\n');

  // Run multiple queries to get stable recall stats
  const NUM_QUERIES = 50;
  const multipliers = [3, 5, 10, 20];
  const recallStats = Object.fromEntries(multipliers.map(m => [m, []]));
  
  const corpusBVecs = vectors.filter(v => v.cid === 'b');

  for (let q = 0; q < NUM_QUERIES; q++) {
    const queryVec = randomVector(VECTOR_DIM);

    // Ground truth: exact top-K from corpus B
    const exactTopK = corpusBVecs
      .map(v => ({ id: v.id, dist: cosineDistance(queryVec, v.vec) }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, TOP_K);
    const exactIds = new Set(exactTopK.map(v => v.id));

    // Test each multiplier
    for (const mult of multipliers) {
      const qps = await conn.prepare('CALL QUERY_VECTOR_INDEX("VN", "vi", $vec, $k) RETURN node.id AS id, node.corpus_id AS cid, distance');
      const r = await conn.execute(qps, { vec: queryVec, k: TOP_K * mult });
      const rows = await r.getAll();
      const filtered = rows.filter(r => r.cid === 'b').slice(0, TOP_K);
      const retrievedIds = new Set(filtered.map(r => r.id));
      const recall = [...exactIds].filter(id => retrievedIds.has(id)).length / exactIds.size;
      recallStats[mult].push(recall);
    }
  }

  // Print results
  console.log(`Results over ${NUM_QUERIES} random queries:\n`);
  console.log('| Over-fetch | Mean Recall | Min Recall | P5 Recall | P95 Recall |');
  console.log('|------------|-------------|------------|-----------|------------|');
  for (const mult of multipliers) {
    const stats = recallStats[mult].sort((a, b) => a - b);
    const mean = stats.reduce((s, x) => s + x, 0) / stats.length;
    const min = stats[0];
    const p5 = stats[Math.floor(stats.length * 0.05)];
    const p95 = stats[Math.floor(stats.length * 0.95)];
    const pass = mean >= 0.95 ? '✓' : '✗';
    console.log(`| ×${mult.toString().padEnd(10)} | ${(mean*100).toFixed(1).padStart(10)}% | ${(min*100).toFixed(1).padStart(9)}% | ${(p5*100).toFixed(1).padStart(8)}% | ${(p95*100).toFixed(1).padStart(9)}% | ${pass}`);
  }

  // ADR-002 summary
  console.log('\n=== ADR-002 DECISION ===');
  console.log('PROJECT_GRAPH + QUERY_VECTOR_INDEX: NO-GO');
  console.log('  - PROJECT_GRAPH fails with "must contain exactly one node table"');
  console.log('  - Even with single table, filter binding fails');
  console.log('  - YIELD ... WHERE is not supported in this version');
  console.log('');
  console.log('Fallback strategy: Global HNSW + over-fetch + application-level corpus_id filter');
  
  const bestMult = multipliers.find(m => {
    const stats = recallStats[m];
    const mean = stats.reduce((s, x) => s + x, 0) / stats.length;
    return mean >= 0.95;
  });
  if (bestMult) {
    console.log(`Recommended over-fetch multiplier: ×${bestMult} (first to achieve mean recall ≥ 95%)`);
  } else {
    console.log('WARNING: No multiplier achieved mean recall ≥ 95%. Consider per-corpus indexes.');
  }

  db.close();
  console.log('\n=== SPIKE COMPLETE ===');
}

main().catch(e => { console.error('Spike failed:', e); process.exit(1); });
