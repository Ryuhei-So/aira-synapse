import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { FileVectorIndex } from '../../../../src/infrastructure/storage/FileVectorIndex.js';
import type { VectorRecord } from '../../../../src/domain/storage/graphStore.js';

describe('TASK-MG-022: FileVectorIndex', () => {
  let tempDir: string;
  let index: FileVectorIndex;

  beforeEach(() => {
    tempDir = mkdtempSync(resolve(tmpdir(), 'memgraphrag-vec-'));
    index = new FileVectorIndex(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const makeRecord = (
    id: string,
    values: number[],
    namespace: 'schema' | 'fact' | 'passage' | 'entity' = 'fact',
    corpusId = 'corpus-1',
  ): VectorRecord<{ documentId: string }> => ({
    id,
    corpusId,
    namespace,
    values,
    metadata: { documentId: 'doc-1' },
  });

  describe('upsert and search', () => {
    it('should store and retrieve vectors', async () => {
      await index.upsert([
        makeRecord('v1', [1, 0, 0]),
        makeRecord('v2', [0, 1, 0]),
        makeRecord('v3', [0, 0, 1]),
      ]);

      const results = await index.search({
        corpusId: 'corpus-1',
        namespace: 'fact',
        queryVector: [1, 0, 0],
        topK: 3,
      });

      expect(results.length).toBe(3);
      expect(results[0]!.id).toBe('v1');
      expect(results[0]!.score).toBeCloseTo(1.0, 4);
    });

    it('should respect topK limit', async () => {
      await index.upsert([
        makeRecord('v1', [1, 0, 0]),
        makeRecord('v2', [0.9, 0.1, 0]),
        makeRecord('v3', [0, 0, 1]),
      ]);

      const results = await index.search({
        corpusId: 'corpus-1',
        namespace: 'fact',
        queryVector: [1, 0, 0],
        topK: 1,
      });

      expect(results.length).toBe(1);
    });

    it('should apply threshold filter', async () => {
      await index.upsert([
        makeRecord('v1', [1, 0, 0]),
        makeRecord('v2', [0, 1, 0]),
      ]);

      const results = await index.search({
        corpusId: 'corpus-1',
        namespace: 'fact',
        queryVector: [1, 0, 0],
        topK: 10,
        threshold: 0.9,
      });

      expect(results.length).toBe(1);
      expect(results[0]!.id).toBe('v1');
    });
  });

  describe('namespace partition', () => {
    it('should isolate namespaces', async () => {
      await index.upsert([makeRecord('v1', [1, 0, 0], 'fact')]);
      await index.upsert([makeRecord('v2', [1, 0, 0], 'schema')]);

      const factResults = await index.search({
        corpusId: 'corpus-1',
        namespace: 'fact',
        queryVector: [1, 0, 0],
        topK: 10,
      });
      const schemaResults = await index.search({
        corpusId: 'corpus-1',
        namespace: 'schema',
        queryVector: [1, 0, 0],
        topK: 10,
      });

      expect(factResults.length).toBe(1);
      expect(factResults[0]!.id).toBe('v1');
      expect(schemaResults.length).toBe(1);
      expect(schemaResults[0]!.id).toBe('v2');
    });
  });

  describe('corpus isolation', () => {
    it('should isolate corpora', async () => {
      await index.upsert([makeRecord('v1', [1, 0, 0], 'fact', 'corpus-1')]);
      await index.upsert([makeRecord('v2', [1, 0, 0], 'fact', 'corpus-2')]);

      const results1 = await index.search({
        corpusId: 'corpus-1',
        namespace: 'fact',
        queryVector: [1, 0, 0],
        topK: 10,
      });
      const results2 = await index.search({
        corpusId: 'corpus-2',
        namespace: 'fact',
        queryVector: [1, 0, 0],
        topK: 10,
      });

      expect(results1.length).toBe(1);
      expect(results1[0]!.id).toBe('v1');
      expect(results2.length).toBe(1);
      expect(results2[0]!.id).toBe('v2');
    });
  });

  describe('deleteByDocument', () => {
    it('should soft-delete vectors by document', async () => {
      await index.upsert([
        { ...makeRecord('v1', [1, 0, 0]), metadata: { documentId: 'doc-1' } },
        { ...makeRecord('v2', [0, 1, 0]), metadata: { documentId: 'doc-2' } },
      ]);

      await index.deleteByDocument('corpus-1', 'doc-1');

      const results = await index.search({
        corpusId: 'corpus-1',
        namespace: 'fact',
        queryVector: [1, 0, 0],
        topK: 10,
      });

      expect(results.length).toBe(1);
      expect(results[0]!.id).toBe('v2');
    });
  });

  describe('upsert overwrite', () => {
    it('should replace existing vector on re-upsert', async () => {
      await index.upsert([makeRecord('v1', [1, 0, 0])]);
      await index.upsert([makeRecord('v1', [0, 1, 0])]);

      const results = await index.search({
        corpusId: 'corpus-1',
        namespace: 'fact',
        queryVector: [0, 1, 0],
        topK: 1,
      });

      expect(results[0]!.id).toBe('v1');
      expect(results[0]!.score).toBeCloseTo(1.0, 4);
    });
  });

  describe('empty index', () => {
    it('should return empty results for non-existent namespace', async () => {
      const results = await index.search({
        corpusId: 'nonexistent',
        namespace: 'fact',
        queryVector: [1, 0, 0],
        topK: 10,
      });
      expect(results).toEqual([]);
    });
  });
});
