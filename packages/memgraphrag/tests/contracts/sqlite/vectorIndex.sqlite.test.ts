/**
 * Run IVectorIndex contract tests against FileVectorIndex.
 */

import { describe } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { FileVectorIndex } from '../../../src/infrastructure/storage/FileVectorIndex.js';
import { vectorIndexContractTests } from '../vectorIndex.contract.js';

describe('IVectorIndex contract — FileVectorIndex', () => {
  let tempDir: string;

  vectorIndexContractTests({
    vectorDim: 3,
    async create() {
      tempDir = mkdtempSync(resolve(tmpdir(), 'vec-contract-'));
      return new FileVectorIndex(tempDir);
    },
    async teardown() {
      rmSync(tempDir, { recursive: true, force: true });
    },
  });
});
