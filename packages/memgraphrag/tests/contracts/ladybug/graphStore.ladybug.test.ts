/**
 * Run IGraphStore contract tests against LadybugGraphStore.
 *
 * Uses a single LadybugDB instance across all tests to avoid Mmap exhaustion.
 * Data is cleaned between tests via DETACH DELETE.
 */

import { describe, beforeAll, afterAll } from 'vitest';
import { LadybugConnectionPool } from '../../../src/infrastructure/storage/ladybug/LadybugConnection.js';
import { LadybugGraphStore } from '../../../src/infrastructure/storage/ladybug/LadybugGraphStore.js';
import { graphStoreContractTests } from '../graphStore.contract.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('IGraphStore contract — LadybugGraphStore', () => {
  let pool: LadybugConnectionPool;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ladybug-gs-'));
    pool = new LadybugConnectionPool(join(dir, 'test.lbug'));
    await pool.init();
  });

  afterAll(async () => {
    if (pool) await pool.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  graphStoreContractTests({
    async create() {
      // Clean all data before each test
      try { await pool.query('MATCH (n:GNode) DETACH DELETE n'); } catch { /* ignore */ }
      return new LadybugGraphStore(pool);
    },
    async teardown() {
      // no-op — pool is shared
    },
  });
});
