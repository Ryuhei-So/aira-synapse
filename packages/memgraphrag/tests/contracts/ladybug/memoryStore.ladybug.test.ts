/**
 * Run IMemoryStore contract tests against LadybugMemoryStore.
 * Single shared pool to avoid Mmap exhaustion.
 */

import { describe, beforeAll, afterAll } from 'vitest';
import { LadybugConnectionPool } from '../../../src/infrastructure/storage/ladybug/LadybugConnection.js';
import { LadybugMemoryStore } from '../../../src/infrastructure/storage/ladybug/LadybugMemoryStore.js';
import { memoryStoreContractTests } from '../memoryStore.contract.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('IMemoryStore contract — LadybugMemoryStore', () => {
  let pool: LadybugConnectionPool;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ladybug-ms-'));
    pool = new LadybugConnectionPool(join(dir, 'test.lbug'));
    await pool.init();
  });

  afterAll(async () => {
    if (pool) await pool.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  memoryStoreContractTests({
    async create() {
      // Clean all memory tables
      try { await pool.query('MATCH (n:SchemaNode) DELETE n'); } catch { /* ignore */ }
      try { await pool.query('MATCH (n:FactNode) DELETE n'); } catch { /* ignore */ }
      try { await pool.query('MATCH (n:PassageNode) DELETE n'); } catch { /* ignore */ }
      try { await pool.query('MATCH (n:JobCheckpointNode) DELETE n'); } catch { /* ignore */ }
      return new LadybugMemoryStore(pool);
    },
    async teardown() {
      // no-op — pool is shared
    },
  });
});
