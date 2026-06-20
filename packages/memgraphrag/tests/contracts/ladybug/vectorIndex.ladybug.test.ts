/**
 * Run IVectorIndex contract tests against LadybugVectorIndex.
 * Single shared pool to avoid Mmap exhaustion.
 */

import { describe, beforeAll, afterAll } from 'vitest';
import { LadybugConnectionPool } from '../../../src/infrastructure/storage/ladybug/LadybugConnection.js';
import { LadybugVectorIndex } from '../../../src/infrastructure/storage/ladybug/LadybugVectorIndex.js';
import { vectorIndexContractTests } from '../vectorIndex.contract.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('IVectorIndex contract — LadybugVectorIndex', () => {
  let pool: LadybugConnectionPool;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ladybug-vi-'));
    pool = new LadybugConnectionPool(join(dir, 'test.lbug'), 1536);
    await pool.init();
  });

  afterAll(async () => {
    if (pool) await pool.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  vectorIndexContractTests({
    vectorDim: 1536,
    async create() {
      // Clean data and rebuild HNSW index (required after bulk deletes)
      try { await pool.query('MATCH (v:VectorEntry) DELETE v'); } catch { /* ignore */ }
      await pool.rebuildVectorIndex();
      return new LadybugVectorIndex(pool);
    },
    async teardown() {
      // no-op — pool is shared
    },
  });
});
