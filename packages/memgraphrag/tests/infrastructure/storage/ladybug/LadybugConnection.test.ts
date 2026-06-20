/**
 * Tests for LadybugConnectionPool.
 * DES-LDB-001: Connection lifecycle, extension loading, schema init.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { LadybugConnectionPool } from '../../../../src/infrastructure/storage/ladybug/LadybugConnection.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ladybug-test-'));
}

describe('LadybugConnectionPool', () => {
  const dirs: string[] = [];
  const pools: LadybugConnectionPool[] = [];

  function createPool(): LadybugConnectionPool {
    const dir = createTempDir();
    dirs.push(dir);
    const pool = new LadybugConnectionPool(join(dir, 'test.lbug'), 1536);
    pools.push(pool);
    return pool;
  }

  afterEach(async () => {
    for (const pool of pools) {
      await pool.close();
    }
    pools.length = 0;
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it('initializes and creates schema tables', async () => {
    const pool = createPool();
    await pool.init();

    // Check that GNode table exists
    const result = await pool.query(
      'MATCH (n:GNode) RETURN count(n) AS c',
    );
    const rows = await result.getAll();
    expect(rows[0]?.c).toBe(0);
  });

  it('creates VectorEntry table with HNSW index', async () => {
    const pool = createPool();
    await pool.init();

    // Insert a vector and search
    await pool.execute(
      'CREATE (n:VectorEntry {pk: $pk, corpus_id: $cid, entry_id: $eid, namespace: $ns, vec: $vec, meta_json: $mj, document_ids: $dids})',
      {
        pk: 'test:v1', cid: 'test', eid: 'v1', ns: 'passage',
        vec: new Array(1536).fill(0).map((_, i) => i === 0 ? 1.0 : 0.0),
        mj: '{}', dids: '[]',
      },
    );

    const result = await pool.execute(
      'CALL QUERY_VECTOR_INDEX("VectorEntry", "vec_idx", $vec, 1) RETURN node, distance',
      { vec: new Array(1536).fill(0).map((_, i) => i === 0 ? 1.0 : 0.0) },
    );
    const rows = await result.getAll();
    expect(rows).toHaveLength(1);
    expect((rows[0]?.node as Record<string, unknown>)?.pk).toBe('test:v1');
  });

  it('creates PassageNode FTS index', async () => {
    const pool = createPool();
    await pool.init();

    await pool.execute(
      'CREATE (n:PassageNode {pk: $pk, corpus_id: $cid, passage_id: $pid, document_id: $did, text: $text, data_json: $dj})',
      { pk: 'test:p1', cid: 'test', pid: 'p1', did: 'd1', text: 'quantum computing advances', dj: '{}' },
    );

    const result = await pool.execute(
      'CALL QUERY_FTS_INDEX("PassageNode", "passage_fts_idx", $q) YIELD node, score RETURN node.pk AS pk, score',
      { q: 'quantum' },
    );
    const rows = await result.getAll();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]?.pk).toBe('test:p1');
  });

  it('creates FactNode FTS index', async () => {
    const pool = createPool();
    await pool.init();

    await pool.execute(
      'CREATE (n:FactNode {pk: $pk, corpus_id: $cid, fact_id: $fid, head_entity: $h, tail_entity: $t, passage_id: $pid, data_json: $dj})',
      { pk: 'test:f1', cid: 'test', fid: 'f1', h: 'Albert Einstein', t: 'physics', pid: 'p1', dj: '{}' },
    );

    const result = await pool.execute(
      'CALL QUERY_FTS_INDEX("FactNode", "fact_fts_idx", $q) YIELD node, score RETURN node.pk AS pk, score',
      { q: 'Einstein' },
    );
    const rows = await result.getAll();
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it('supports parameterized queries via execute()', async () => {
    const pool = createPool();
    await pool.init();

    await pool.execute(
      'CREATE (n:GNode {pk: $pk, corpus_id: $cid, node_id: $nid, layer: $l, label: $lbl, ref_json: $rj, document_ids: $dids})',
      { pk: 'c1:n1', cid: 'c1', nid: 'n1', l: 'fact', lbl: 'test', rj: '{}', dids: '["d1"]' },
    );

    const result = await pool.execute(
      'MATCH (n:GNode {pk: $pk}) RETURN n.label AS label',
      { pk: 'c1:n1' },
    );
    const rows = await result.getAll();
    expect(rows[0]?.label).toBe('test');
  });

  it('handles concurrent withConnection calls', async () => {
    const pool = createPool();
    await pool.init();

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        pool.execute('RETURN $i AS val', { i }),
      ),
    );

    for (let i = 0; i < 10; i++) {
      const rows = await results[i]!.getAll();
      expect(rows[0]?.val).toBe(i);
    }
  });

  it('emits and receives graphMutation events', async () => {
    const pool = createPool();
    await pool.init();

    const mutations: string[] = [];
    const listener = (corpusId: string) => mutations.push(corpusId);
    pool.onGraphMutation(listener);

    pool.emitGraphMutation('corpus-a');
    pool.emitGraphMutation('corpus-b');

    expect(mutations).toEqual(['corpus-a', 'corpus-b']);

    pool.offGraphMutation(listener);
    pool.emitGraphMutation('corpus-c');
    expect(mutations).toEqual(['corpus-a', 'corpus-b']); // listener removed
  });

  it('removes all listeners on close()', async () => {
    const pool = createPool();
    await pool.init();

    const mutations: string[] = [];
    pool.onGraphMutation((cid) => mutations.push(cid));

    await pool.close();
    // After close, emitting should not throw but listener is gone
    // Re-init to test fresh state
    const pool2 = createPool();
    await pool2.init();
    pool2.emitGraphMutation('test');
    expect(mutations).toEqual([]); // old listener not carried over
  });

  it('is idempotent on double init()', async () => {
    const pool = createPool();
    await pool.init();
    await pool.init(); // should not throw

    const result = await pool.query('MATCH (n:GNode) RETURN count(n) AS c');
    const rows = await result.getAll();
    expect(rows[0]?.c).toBe(0);
  });
});
