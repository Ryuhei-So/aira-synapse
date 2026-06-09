import { describe, expect, it, beforeEach } from 'vitest';
import { Bm25LexicalRetriever } from '../../../../src/infrastructure/retrieval/Bm25LexicalRetriever.js';
import type { Passage } from '../../../../src/domain/memory/passage.js';

function createPassage(passageId: string, documentId: string, text: string): Passage {
  return {
    passageId,
    corpusId: 'corpus-1',
    text,
    normalizedText: text.toLowerCase(),
    metadata: {
      documentId,
      title: `Doc ${documentId}`,
      sourceUrl: `https://example.com/${documentId}`,
      language: 'en',
      sectionPath: ['Intro'],
      chunkId: `${documentId}:0`,
      chunkIndex: 0,
      offsetStart: 0,
      offsetEnd: text.length,
    },
    factIds: [],
    entityMentions: [],
    qualityFlags: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('TASK-MG-046: Bm25LexicalRetriever', () => {
  let retriever: Bm25LexicalRetriever;

  beforeEach(() => {
    retriever = new Bm25LexicalRetriever();
  });

  it('ranks passages by BM25 relevance', async () => {
    await retriever.indexPassages('corpus-1', [
      createPassage('p1', 'doc-1', 'graph retrieval graph retrieval ranking'),
      createPassage('p2', 'doc-2', 'protein folding for biology'),
      createPassage('p3', 'doc-3', 'graph ranking with citations'),
    ]);

    const results = await retriever.search('corpus-1', 'graph retrieval', 2);

    expect(results).toHaveLength(2);
    expect(results[0]?.passageId).toBe('p1');
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });

  it('removes passages by document id', async () => {
    await retriever.indexPassages('corpus-1', [
      createPassage('p1', 'doc-1', 'graph retrieval ranking'),
      createPassage('p2', 'doc-2', 'graph retrieval ranking'),
    ]);

    await retriever.deleteByDocument('corpus-1', 'doc-1');
    const results = await retriever.search('corpus-1', 'graph retrieval', 10);

    expect(results.map((result) => result.passageId)).toEqual(['p2']);
  });

  it('isolates indexes per corpus', async () => {
    await retriever.indexPassages('corpus-1', [createPassage('p1', 'doc-1', 'graph retrieval ranking')]);
    await retriever.indexPassages('corpus-2', [{ ...createPassage('p9', 'doc-9', 'biology pathway analysis'), corpusId: 'corpus-2' }]);

    await expect(retriever.search('corpus-1', 'biology', 5)).resolves.toEqual([]);
    await expect(retriever.search('corpus-2', 'biology', 5)).resolves.toEqual([expect.objectContaining({ passageId: 'p9' })]);
  });
});
