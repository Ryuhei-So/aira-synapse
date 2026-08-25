import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

import { createStorageAdapters } from '../../../src/infrastructure/storage/ladybug/storageFactory.js';
import { SnapshotBackedIndexingMemory } from '../../../src/infrastructure/storage/SnapshotBackedIndexingMemory.js';
import { SQLiteMemoryStore } from '../../../src/infrastructure/storage/SQLiteMemoryStore.js';
import { openDatabase, runMigrations } from '../../../src/infrastructure/storage/migrate.js';
import type { AiraGraphDbTrafficEvent } from '../../../src/infrastructure/storage/aira-graphdb/NativeClient.js';
import type { Fact } from '../../../src/domain/memory/fact.js';
import type { Passage } from '../../../src/domain/memory/passage.js';
import type { Schema } from '../../../src/domain/memory/schema.js';
import { buildDocumentMemoryDelta } from '../../../src/application/indexing/DocumentMemoryPlan.js';

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

function createSchema(schemaId: string): Schema {
  return {
    schemaId,
    corpusId: CORPUS_ID,
    headType: 'person',
    relation: 'authors',
    tailType: 'paper',
    canonicalKey: 'person::authors::paper',
    aliases: [],
    frequency: 2,
    state: 'stable',
    stabilizationThreshold: 2,
    factIds: ['f1'],
    sourceDocumentIds: ['doc-1'],
    version: 1,
    createdAt: TS,
    updatedAt: TS,
  };
}

function createFact(factId: string, schemaId: string): Fact {
  return {
    factId,
    corpusId: CORPUS_ID,
    schemaId,
    headEntity: 'Alice',
    headType: 'person',
    relation: 'authors',
    tailEntity: 'Paper',
    tailType: 'paper',
    state: 'inactive',
    passageIds: ['p1'],
    sourceDocumentIds: ['doc-1'],
    confidence: 0.9,
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

      await adapters.batch.begin();
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
      await adapters.batch.commit();
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

      await adapters.batch.begin();
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
      await adapters.batch.commit();
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

      await adapters.batch.begin();
      await adapters.lexicalRetriever.indexPassages(CORPUS_ID, [
        createPassage('p1', 'doc-1', 'graph retrieval graph retrieval'),
        createPassage('p2', 'doc-2', 'biology and proteins'),
      ]);
      const hits = await adapters.lexicalRetriever.search(CORPUS_ID, 'graph retrieval', 2);
      expect(hits[0]?.passageId).toBe('p1');
      await adapters.batch.commit();
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

      await adapters.batch.begin();
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
      await adapters.batch.commit();
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

      await adapters.batch.begin();
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
      await adapters.batch.commit();
      await adapters.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('storage-port-compat:indexing-memory stays bounded and persists atomically', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aira-graphdb-compat-indexing-memory-'));
    const dbPath = join(dir, 'graphdb-native.json');
    const snapshotDb = openDatabase(join(dir, 'snapshot.sqlite'));
    runMigrations(snapshotDb);
    snapshotDb.prepare('INSERT INTO corpora (corpus_id, name, description) VALUES (?, ?, ?)')
      .run(CORPUS_ID, 'Parity corpus', 'Snapshot-backed parity fixture');
    snapshotDb.prepare(
      'INSERT INTO documents (document_id, corpus_id, title, source_url) VALUES (?, ?, ?, ?)',
    ).run('doc-1', CORPUS_ID, 'Parity document', 'https://example.com/doc-1');
    const traffic: AiraGraphDbTrafficEvent[] = [];
    try {
      const adapters = await createStorageAdapters({
        backend: 'aira-graphdb',
        airaGraphDb: { dbPath, onTraffic: (event) => traffic.push(event) },
      });
      const memory = adapters.indexingMemory;
      const schema = { ...createSchema('s1'), factIds: [] };
      const fact = createFact('f1', schema.schemaId);
      const passage = createPassage('p1', 'doc-1', 'Alice authors Paper');
      const delta = buildDocumentMemoryDelta(
        CORPUS_ID,
        [schema],
        [fact],
        [passage],
        TS,
      );
      expect(delta.schemas[0]?.factIds).toEqual(['f1']);
      expect(delta.passages[0]?.factIds).toEqual(['f1']);
      const activation = { corpusId: CORPUS_ID, schemaIds: ['s1'], updatedAt: TS };
      const snapshotMemory = new SnapshotBackedIndexingMemory(new SQLiteMemoryStore(snapshotDb));
      snapshotMemory.preflightMutation({ delta, activation });
      await snapshotMemory.upsertDelta(delta);
      await expect(snapshotMemory.activateFactsBySchemaIds(activation)).resolves.toBe(1);
      const expectedSchemas = await snapshotMemory.getSchemasByIds({
        corpusId: CORPUS_ID,
        schemaIds: ['s1'],
      });
      const expectedActiveFacts = await snapshotMemory.getActiveFacts({
        corpusId: CORPUS_ID,
        limit: 100,
      });

      await adapters.batch.begin();
      memory.preflightMutation({ delta, activation });
      await memory.upsertDelta(delta);
      await expect(memory.getSchemasByIds({ corpusId: CORPUS_ID, schemaIds: ['s1'] }))
        .resolves.toEqual(expectedSchemas);
      await expect(memory.getActiveFacts({ corpusId: CORPUS_ID, limit: 100 }))
        .resolves.toEqual([]);
      await expect(memory.activateFactsBySchemaIds(activation)).resolves.toBe(1);
      await expect(memory.getActiveFacts({ corpusId: CORPUS_ID, limit: 100 }))
        .resolves.toEqual(expectedActiveFacts);
      await adapters.batch.commit();
      await adapters.close();

      const reopened = await createStorageAdapters({
        backend: 'aira-graphdb',
        airaGraphDb: { dbPath, onTraffic: (event) => traffic.push(event) },
      });
      await expect(reopened.indexingMemory.getSchemasByIds({
        corpusId: CORPUS_ID,
        schemaIds: ['s1'],
      })).resolves.toEqual(expectedSchemas);
      await expect(reopened.indexingMemory.getActiveFacts({ corpusId: CORPUS_ID, limit: 100 }))
        .resolves.toEqual(expectedActiveFacts);
      await reopened.close();

      expect(traffic.some(({ method }) => method === 'memory_load' || method === 'memory_save'))
        .toBe(false);
      expect(traffic.filter(({ method }) => method === 'memory_upsert')).toHaveLength(1);
      expect(traffic.filter(({ method }) => method === 'memory_activate_facts_by_schema_ids'))
        .toHaveLength(1);
      expect(traffic.every(({ requestBytes, responseBytes }) => requestBytes <= 64 * 1024 * 1024
        && (responseBytes === undefined || responseBytes <= 8 * 1024 * 1024))).toBe(true);
    } finally {
      snapshotDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
