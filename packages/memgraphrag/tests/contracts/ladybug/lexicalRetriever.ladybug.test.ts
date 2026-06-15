/**
 * Run ILexicalRetriever contract tests against LadybugLexicalRetriever.
 * Single shared pool to avoid Mmap exhaustion.
 */

import { describe, beforeAll, afterAll } from 'vitest';
import { LadybugConnectionPool } from '../../../src/infrastructure/storage/ladybug/LadybugConnection.js';
import { LadybugLexicalRetriever } from '../../../src/infrastructure/storage/ladybug/LadybugLexicalRetriever.js';
import { lexicalRetrieverContractTests } from '../lexicalRetriever.contract.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('ILexicalRetriever contract — LadybugLexicalRetriever', () => {
  let pool: LadybugConnectionPool;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ladybug-lr-'));
    pool = new LadybugConnectionPool(join(dir, 'test.lbug'));
    await pool.init();
  });

  afterAll(async () => {
    if (pool) await pool.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  lexicalRetrieverContractTests({
    async create() {
      // Clean passages and facts
      try { await pool.query('MATCH (n:PassageNode) DELETE n'); } catch { /* ignore */ }
      try { await pool.query('MATCH (n:FactNode) DELETE n'); } catch { /* ignore */ }
      return new LadybugLexicalRetriever(pool);
    },
    async teardown() {
      // no-op — pool is shared
    },
  });
});
