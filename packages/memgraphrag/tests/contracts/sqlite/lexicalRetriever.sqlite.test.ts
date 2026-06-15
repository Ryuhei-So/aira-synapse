/**
 * Run ILexicalRetriever contract tests against Bm25LexicalRetriever.
 */

import { describe } from 'vitest';
import { Bm25LexicalRetriever } from '../../../src/infrastructure/retrieval/Bm25LexicalRetriever.js';
import { lexicalRetrieverContractTests } from '../lexicalRetriever.contract.js';

describe('ILexicalRetriever contract — Bm25LexicalRetriever', () => {
  lexicalRetrieverContractTests({
    async create() {
      return new Bm25LexicalRetriever();
    },
    async teardown() {
      // In-memory, nothing to clean up
    },
  });
});
