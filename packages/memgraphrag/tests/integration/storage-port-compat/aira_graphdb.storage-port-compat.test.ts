import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

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

describe('TASK-AGDB-037 storage-port-compat', () => {
  it('storage-port-compat:graph-crud', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aira-graphdb-compat-graph-'));
    try {
      const adapters = await createStorageAdapters({
        backend: 'aira-graphdb',
        airaGraphDb: {
          dbPath: join(dir, 'graphdb-native.json'),
        },
      });

      await adapters.graphStore.upsertNodes([
        {
          nodeId: 'n1',
          corpusId: CORPUS_ID,
          layer: 'fact',
          ref: { id: 'r1' },
          label: 'Node 1',
        },
      ]);
      const found = await adapters.graphStore.getNode(CORPUS_ID, 'n1');
      expect(found?.nodeId).toBe('n1');
      await adapters.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('storage-port-compat:vector-crud', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aira-graphdb-compat-vector-'));
    try {
      const adapters = await createStorageAdapters({
        backend: 'aira-graphdb',
        airaGraphDb: {
          dbPath: join(dir, 'graphdb-native.json'),
        },
      });

      await adapters.vectorIndex.upsert([
        {
          id: 'v1',
          corpusId: CORPUS_ID,
          namespace: 'fact',
          values: [1, 0, 0],
          metadata: { documentId: 'doc-1' },
        },
        {
          id: 'v2',
          corpusId: CORPUS_ID,
          namespace: 'fact',
          values: [0, 1, 0],
          metadata: { documentId: 'doc-2' },
        },
      ]);

      const hits = await adapters.vectorIndex.search({
        corpusId: CORPUS_ID,
        namespace: 'fact',
        queryVector: [1, 0, 0],
        topK: 2,
      });
      expect(hits[0]?.id).toBe('v1');

      await adapters.vectorIndex.deleteByDocument(CORPUS_ID, 'doc-1');
      const afterDelete = await adapters.vectorIndex.search({
        corpusId: CORPUS_ID,
        namespace: 'fact',
        queryVector: [1, 0, 0],
        topK: 2,
      });
      expect(afterDelete.find((v) => v.id === 'v1')).toBeUndefined();
      await adapters.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('storage-port-compat:lexical-search', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aira-graphdb-compat-lexical-'));
    try {
      const adapters = await createStorageAdapters({
        backend: 'aira-graphdb',
        airaGraphDb: {
          dbPath: join(dir, 'graphdb-native.json'),
        },
      });

      await adapters.lexicalRetriever.indexPassages(CORPUS_ID, [
        createPassage('p1', 'doc-1', 'graph retrieval graph retrieval'),
        createPassage('p2', 'doc-2', 'biology and proteins'),
      ]);
      const hits = await adapters.lexicalRetriever.search(CORPUS_ID, 'graph retrieval', 2);
      expect(hits[0]?.passageId).toBe('p1');
      await adapters.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('storage-port-compat:memory-crud', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aira-graphdb-compat-memory-'));
    try {
      const adapters = await createStorageAdapters({
        backend: 'aira-graphdb',
        airaGraphDb: {
          dbPath: join(dir, 'graphdb-native.json'),
        },
      });

      await adapters.memoryStore.save({
        corpusId: CORPUS_ID,
        exportedAt: TS,
        schemas: [],
        facts: [],
        passages: [createPassage('p1', 'doc-1', 'graph retrieval')],
        schemaVersion: 1,
      });
      const loaded = await adapters.memoryStore.load(CORPUS_ID);
      expect(loaded.passages).toHaveLength(1);
      await adapters.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('storage-port-compat:projection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aira-graphdb-compat-proj-'));
    try {
      const adapters = await createStorageAdapters({
        backend: 'aira-graphdb',
        airaGraphDb: {
          dbPath: join(dir, 'graphdb-native.json'),
        },
      });

      await adapters.graphStore.upsertNodes([
        { nodeId: 'a', corpusId: CORPUS_ID, layer: 'ontology', ref: { id: 'a' }, label: 'A' },
        { nodeId: 'b', corpusId: CORPUS_ID, layer: 'fact', ref: { id: 'b' }, label: 'B' },
      ]);
      await adapters.graphStore.upsertEdges([
        {
          edgeId: 'e1',
          corpusId: CORPUS_ID,
          sourceNodeId: 'a',
          targetNodeId: 'b',
          relation: 'schema_instance',
          weight: 1,
        },
      ]);

      const count = await adapters.graphProjection.getNodeCount(CORPUS_ID);
      expect(count).toBe(2);

      const transitions: Array<{ sourceNodeId: string; targetNodeId: string; weight: number }> = [];
      for await (const t of adapters.graphProjection.getTransitions(CORPUS_ID)) {
        transitions.push(t);
      }
      expect(transitions).toHaveLength(1);
      expect(transitions[0]?.sourceNodeId).toBe('a');
      await adapters.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
