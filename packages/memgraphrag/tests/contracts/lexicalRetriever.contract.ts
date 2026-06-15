/**
 * Contract test suite for ILexicalRetriever implementations.
 */

import { it, expect, beforeEach, afterEach } from 'vitest';
import type { ILexicalRetriever } from '../../src/domain/retrieval/ppr.js';
import type { Passage } from '../../src/domain/memory/passage.js';

const CORPUS = 'corpus-1';
const TS = '2026-01-01T00:00:00.000Z';

function createPassage(passageId: string, documentId: string, text: string): Passage {
  return {
    passageId, corpusId: CORPUS, text,
    normalizedText: text.toLowerCase(),
    metadata: {
      documentId, title: `Doc ${documentId}`, sourceUrl: `https://example.com/${documentId}`,
      language: 'en', sectionPath: ['Intro'], chunkId: `${documentId}:0`,
      chunkIndex: 0, offsetStart: 0, offsetEnd: text.length,
    },
    factIds: [], entityMentions: [], qualityFlags: [],
    createdAt: TS, updatedAt: TS,
  };
}

export interface LexicalRetrieverFactory {
  create(): Promise<ILexicalRetriever>;
  teardown(): Promise<void>;
}

export function lexicalRetrieverContractTests(factory: LexicalRetrieverFactory): void {
  let retriever: ILexicalRetriever;

  beforeEach(async () => { retriever = await factory.create(); });
  afterEach(async () => { await factory.teardown(); });

  it('ranks passages by text relevance', async () => {
    await retriever.indexPassages(CORPUS, [
      createPassage('p1', 'doc-1', 'graph retrieval graph retrieval ranking'),
      createPassage('p2', 'doc-2', 'protein folding for biology'),
      createPassage('p3', 'doc-3', 'graph ranking with citations'),
    ]);

    const results = await retriever.search(CORPUS, 'graph retrieval', 2);
    expect(results).toHaveLength(2);
    expect(results[0]?.passageId).toBe('p1');
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });

  it('removes passages by document', async () => {
    await retriever.indexPassages(CORPUS, [
      createPassage('p1', 'doc-1', 'graph retrieval ranking'),
      createPassage('p2', 'doc-2', 'graph retrieval ranking'),
    ]);

    await retriever.deleteByDocument(CORPUS, 'doc-1');
    const results = await retriever.search(CORPUS, 'graph retrieval', 10);
    expect(results.map(r => r.passageId)).toEqual(['p2']);
  });

  it('isolates corpora', async () => {
    await retriever.indexPassages(CORPUS, [createPassage('p1', 'doc-1', 'graph retrieval')]);
    await retriever.indexPassages('corpus-2', [
      { ...createPassage('p9', 'doc-9', 'biology pathway analysis'), corpusId: 'corpus-2' },
    ]);

    const r1 = await retriever.search(CORPUS, 'biology', 5);
    const r2 = await retriever.search('corpus-2', 'biology', 5);

    expect(r1).toHaveLength(0);
    expect(r2).toHaveLength(1);
    expect(r2[0]?.passageId).toBe('p9');
  });

  it('returns empty for non-existent corpus', async () => {
    const results = await retriever.search('nonexistent', 'anything', 10);
    expect(results).toEqual([]);
  });
}
