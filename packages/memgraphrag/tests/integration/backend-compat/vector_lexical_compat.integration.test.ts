import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

import { VectorLexicalCompatEvaluator } from '../../../src/application/query/VectorLexicalCompatEvaluator.js';
import { createStorageAdapters } from '../../../src/infrastructure/storage/ladybug/storageFactory.js';
import type { Passage } from '../../../src/domain/memory/passage.js';

const CORPUS_ID = 'compat-corpus';
const TS = '2026-01-01T00:00:00.000Z';

function createPassage(passageId: string, documentId: string, text: string): Passage {
  return {
    passageId,
    corpusId: CORPUS_ID,
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
    createdAt: TS,
    updatedAt: TS,
  };
}

describe('TASK-AGDB-038 vector/lexical compatibility', () => {
  it('keeps vector topK set equal between sqlite baseline and aira-graphdb backend', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'backend-compat-vector-'));
    const evaluator = new VectorLexicalCompatEvaluator();
    const sqlitePathBaseline = join(dir, 'baseline.sqlite');
    const sqlitePathCandidate = join(dir, 'candidate-native.json');

    const baseline = await createStorageAdapters({
      backend: 'sqlite',
      sqlite: { sqlitePath: sqlitePathBaseline, vectorIndexDir: join(dir, 'baseline-vector') },
    });
    const candidate = await createStorageAdapters({
      backend: 'aira-graphdb',
      airaGraphDb: { dbPath: sqlitePathCandidate },
    });

    try {
      const vectors = [
        { id: 'd1', corpusId: CORPUS_ID, namespace: 'fact' as const, values: [1, 0, 0], metadata: { documentId: 'doc-1' } },
        { id: 'd2', corpusId: CORPUS_ID, namespace: 'fact' as const, values: [0.8, 0.2, 0], metadata: { documentId: 'doc-2' } },
        { id: 'd3', corpusId: CORPUS_ID, namespace: 'fact' as const, values: [0, 1, 0], metadata: { documentId: 'doc-3' } },
      ];
      await baseline.vectorIndex.upsert(vectors);
      await candidate.batch!.begin();
      await candidate.vectorIndex.upsert(vectors);
      await candidate.batch!.commit();

      const baselineHits = await baseline.vectorIndex.search({
        corpusId: CORPUS_ID,
        namespace: 'fact',
        queryVector: [1, 0, 0],
        topK: 2,
        threshold: 0.1,
      });
      const candidateHits = await candidate.vectorIndex.search({
        corpusId: CORPUS_ID,
        namespace: 'fact',
        queryVector: [1, 0, 0],
        topK: 2,
        threshold: 0.1,
      });

      const comparison = evaluator.compareVectorTopK(
        baselineHits.map((v) => ({ id: v.id, score: v.score })),
        candidateHits.map((v) => ({ id: v.id, score: v.score })),
        { threshold: 0.1, scoreRoundingDecimals: 6, thresholdEpsilon: 0.000001 },
      );
      expect(comparison.matchRate).toBe(1);
    } finally {
      await baseline.close();
      await candidate.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('validates lexical schema and ordering', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'backend-compat-lexical-'));
    const evaluator = new VectorLexicalCompatEvaluator();
    const sqlitePath = join(dir, 'candidate-native.json');
    const candidate = await createStorageAdapters({
      backend: 'aira-graphdb',
      airaGraphDb: { dbPath: sqlitePath },
    });
    const passages = [
      createPassage('p1', 'doc-1', 'graph retrieval graph retrieval ranking'),
      createPassage('p2', 'doc-2', 'graph retrieval'),
    ];
    const byPassageId = new Map(passages.map((p) => [p.passageId, p]));

    try {
      await candidate.batch!.begin();
      await candidate.lexicalRetriever.indexPassages(CORPUS_ID, passages);
      await candidate.batch!.commit();
      const hits = await candidate.lexicalRetriever.search(CORPUS_ID, 'graph retrieval', 2);
      const lexicalRows = hits.map((hit) => {
        const passage = byPassageId.get(hit.passageId)!;
        return {
          documentId: passage.metadata.documentId,
          text: passage.text,
          score: hit.score,
          memoryType: 'passage' as const,
        };
      });

      evaluator.assertLexicalSchemaAndSort(lexicalRows);
      expect(lexicalRows.length).toBeGreaterThan(0);
    } finally {
      await candidate.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
