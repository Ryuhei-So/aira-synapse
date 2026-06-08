import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { SQLiteGraphStore } from '../../../../src/infrastructure/storage/SQLiteGraphStore.js';
import { openDatabase, runMigrations } from '../../../../src/infrastructure/storage/migrate.js';
import type { Fact } from '../../../../src/domain/memory/fact.js';
import type { Passage } from '../../../../src/domain/memory/passage.js';
import type { Schema } from '../../../../src/domain/memory/schema.js';
import type { GraphEdge, GraphNode } from '../../../../src/domain/storage/graphStore.js';

const TEST_CORPUS_ID = 'corpus-1';
const OTHER_CORPUS_ID = 'corpus-2';
const DOCUMENT_ID = 'doc-1';
const OTHER_DOCUMENT_ID = 'doc-2';
const TIMESTAMP = '2025-01-01T00:00:00.000Z';

function createSchema(documentId = DOCUMENT_ID): Schema {
  return {
    schemaId: `schema-${documentId}`,
    corpusId: TEST_CORPUS_ID,
    headType: 'Author',
    relation: 'writes',
    tailType: 'Paper',
    canonicalKey: 'author::writes::paper',
    aliases: [
      {
        label: 'Author writes Paper',
        language: 'en',
        source: 'manual',
        confidence: 1,
        isCanonical: true,
      },
    ],
    frequency: 2,
    state: 'stable',
    stabilizationThreshold: 2,
    factIds: ['fact-doc-1'],
    sourceDocumentIds: [documentId],
    version: 1,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

function createFact(documentId = DOCUMENT_ID): Fact {
  return {
    factId: `fact-${documentId}`,
    corpusId: TEST_CORPUS_ID,
    schemaId: `schema-${documentId}`,
    headEntity: 'Ada Lovelace',
    headType: 'Author',
    relation: 'writes',
    tailEntity: 'Analytical Engine Notes',
    tailType: 'Paper',
    state: 'active',
    passageIds: [`passage-${documentId}`],
    sourceDocumentIds: [documentId],
    confidence: 0.98,
    temporalScope: '1843',
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

function createPassage(documentId = DOCUMENT_ID): Passage {
  return {
    passageId: `passage-${documentId}`,
    corpusId: TEST_CORPUS_ID,
    text: 'Ada Lovelace wrote notes on the Analytical Engine.',
    normalizedText: 'ada lovelace wrote notes on the analytical engine',
    metadata: {
      documentId,
      title: `Title ${documentId}`,
      sourceUrl: 'https://example.com/paper',
      sourceType: 'md',
      language: 'en',
      convertedAt: TIMESTAMP,
      sectionPath: ['Introduction'],
      chunkId: `chunk-${documentId}`,
      chunkIndex: 0,
      offsetStart: 0,
      offsetEnd: 52,
    },
    factIds: [`fact-${documentId}`],
    entityMentions: ['Ada Lovelace', 'Analytical Engine'],
    qualityFlags: [],
    qualityScore: 0.9,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

function createNodes(): readonly GraphNode[] {
  return [
    {
      nodeId: 'schema-node-1',
      corpusId: TEST_CORPUS_ID,
      layer: 'ontology',
      ref: createSchema(),
      label: 'Author writes Paper',
    },
    {
      nodeId: 'fact-node-1',
      corpusId: TEST_CORPUS_ID,
      layer: 'fact',
      ref: createFact(),
      label: 'Ada Lovelace writes Analytical Engine Notes',
    },
    {
      nodeId: 'passage-node-1',
      corpusId: TEST_CORPUS_ID,
      layer: 'passage',
      ref: createPassage(),
      label: 'Passage about Ada Lovelace',
    },
  ];
}

function createEdges(): readonly GraphEdge[] {
  return [
    {
      edgeId: 'edge-1',
      corpusId: TEST_CORPUS_ID,
      sourceNodeId: 'schema-node-1',
      targetNodeId: 'fact-node-1',
      relation: 'schema_instance',
      weight: 1,
    },
    {
      edgeId: 'edge-2',
      corpusId: TEST_CORPUS_ID,
      sourceNodeId: 'fact-node-1',
      targetNodeId: 'passage-node-1',
      relation: 'fact_evidence',
      weight: 0.8,
    },
    {
      edgeId: 'edge-3',
      corpusId: TEST_CORPUS_ID,
      sourceNodeId: 'schema-node-1',
      targetNodeId: 'passage-node-1',
      relation: 'similarity_bridge',
      weight: 0.5,
      bridgeKind: 'similarity_based',
    },
  ];
}

describe('TASK-MG-018: SQLiteGraphStore integration', () => {
  let db: Database.Database;
  let store: SQLiteGraphStore;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db);
    db.prepare(
      'INSERT INTO corpora (corpus_id, name, description) VALUES (?, ?, ?)',
    ).run(TEST_CORPUS_ID, 'Test Corpus', 'Graph store integration corpus');
    db.prepare(
      'INSERT INTO corpora (corpus_id, name, description) VALUES (?, ?, ?)',
    ).run(OTHER_CORPUS_ID, 'Other Corpus', 'Isolation corpus');
    store = new SQLiteGraphStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('upserts and retrieves nodes with JSON refs intact', async () => {
    await store.upsertNodes(createNodes());

    const node = await store.getNode(TEST_CORPUS_ID, 'schema-node-1');
    expect(node).not.toBeNull();
    expect(node).toMatchObject({
      nodeId: 'schema-node-1',
      corpusId: TEST_CORPUS_ID,
      layer: 'ontology',
      label: 'Author writes Paper',
    });
    expect(node?.ref).toMatchObject({
      schemaId: 'schema-doc-1',
      sourceDocumentIds: [DOCUMENT_ID],
    });

    await store.upsertNodes([
      {
        nodeId: 'schema-node-1',
        corpusId: TEST_CORPUS_ID,
        layer: 'ontology',
        ref: createSchema(),
        label: 'Updated schema label',
      },
    ]);

    const updated = await store.getNode(TEST_CORPUS_ID, 'schema-node-1');
    expect(updated?.label).toBe('Updated schema label');
  });

  it('filters nodes by corpus and layer', async () => {
    await store.upsertNodes(createNodes());
    await store.upsertNodes([
      {
        nodeId: 'schema-node-other',
        corpusId: OTHER_CORPUS_ID,
        layer: 'ontology',
        ref: {
          ...createSchema(OTHER_DOCUMENT_ID),
          corpusId: OTHER_CORPUS_ID,
        },
        label: 'Other corpus schema',
      },
    ]);

    const ontologyNodes = await store.getNodes(TEST_CORPUS_ID, 'ontology');
    const allNodes = await store.getNodes(TEST_CORPUS_ID);
    const otherNodes = await store.getNodes(OTHER_CORPUS_ID);

    expect(ontologyNodes).toHaveLength(1);
    expect(ontologyNodes[0]?.nodeId).toBe('schema-node-1');
    expect(allNodes).toHaveLength(3);
    expect(otherNodes).toHaveLength(1);
    expect(otherNodes[0]?.corpusId).toBe(OTHER_CORPUS_ID);
  });

  it('returns outgoing and adjacent edges', async () => {
    await store.upsertNodes(createNodes());
    await store.upsertEdges(createEdges());

    const outgoing = await store.getEdges(TEST_CORPUS_ID, 'schema-node-1');
    const adjacent = await store.getAdjacent(TEST_CORPUS_ID, 'fact-node-1');

    expect(outgoing.map((edge) => edge.edgeId)).toEqual(['edge-1', 'edge-3']);
    expect(adjacent.map((edge) => edge.edgeId)).toEqual(['edge-1', 'edge-2']);
    expect(adjacent[1]).toMatchObject({
      relation: 'fact_evidence',
      sourceNodeId: 'fact-node-1',
      targetNodeId: 'passage-node-1',
    });
  });

  it('deletes edges by id', async () => {
    await store.upsertNodes(createNodes());
    await store.upsertEdges(createEdges());

    const deleted = await store.deleteEdges(TEST_CORPUS_ID, ['edge-3']);
    const remaining = await store.getEdges(TEST_CORPUS_ID);

    expect(deleted).toBe(1);
    expect(remaining.map((edge) => edge.edgeId)).toEqual(['edge-1', 'edge-2']);
  });

  it('deletes nodes and their incident edges', async () => {
    await store.upsertNodes(createNodes());
    await store.upsertEdges(createEdges());

    const deletedNodes = await store.deleteNodes(TEST_CORPUS_ID, ['fact-node-1']);
    const remainingNodes = await store.getNodes(TEST_CORPUS_ID);
    const remainingEdges = await store.getEdges(TEST_CORPUS_ID);

    expect(deletedNodes).toBe(1);
    expect(remainingNodes.map((node) => node.nodeId)).toEqual([
      'passage-node-1',
      'schema-node-1',
    ]);
    expect(remainingEdges.map((edge) => edge.edgeId)).toEqual(['edge-3']);
  });

  it('deletes nodes and incident edges by document reference in JSON', async () => {
    await store.upsertNodes([
      ...createNodes(),
      {
        nodeId: 'schema-node-2',
        corpusId: TEST_CORPUS_ID,
        layer: 'ontology',
        ref: createSchema(OTHER_DOCUMENT_ID),
        label: 'Schema from doc-2',
      },
      {
        nodeId: 'passage-node-2',
        corpusId: TEST_CORPUS_ID,
        layer: 'passage',
        ref: createPassage(OTHER_DOCUMENT_ID),
        label: 'Passage from doc-2',
      },
    ]);
    await store.upsertEdges([
      ...createEdges(),
      {
        edgeId: 'edge-4',
        corpusId: TEST_CORPUS_ID,
        sourceNodeId: 'schema-node-2',
        targetNodeId: 'passage-node-2',
        relation: 'fact_evidence',
        weight: 0.6,
      },
    ]);

    const result = await store.deleteByDocument(TEST_CORPUS_ID, DOCUMENT_ID);
    const remainingNodes = await store.getNodes(TEST_CORPUS_ID);
    const remainingEdges = await store.getEdges(TEST_CORPUS_ID);

    expect(result).toEqual({ deletedNodes: 3, deletedEdges: 3 });
    expect(remainingNodes.map((node) => node.nodeId)).toEqual([
      'passage-node-2',
      'schema-node-2',
    ]);
    expect(remainingEdges.map((edge) => edge.edgeId)).toEqual(['edge-4']);
  });

  it('deletes all graph data for a corpus only', async () => {
    await store.upsertNodes(createNodes());
    await store.upsertEdges(createEdges());
    await store.upsertNodes([
      {
        nodeId: 'other-node-1',
        corpusId: OTHER_CORPUS_ID,
        layer: 'passage',
        ref: {
          ...createPassage(OTHER_DOCUMENT_ID),
          corpusId: OTHER_CORPUS_ID,
        },
        label: 'Other corpus passage',
      },
    ]);
    await store.upsertEdges([
      {
        edgeId: 'other-edge-1',
        corpusId: OTHER_CORPUS_ID,
        sourceNodeId: 'other-node-1',
        targetNodeId: 'other-node-1',
        relation: 'part_of',
        weight: 1,
      },
    ]);

    const deleted = await store.deleteByCorpus(TEST_CORPUS_ID);

    expect(deleted).toEqual({ deletedNodes: 3, deletedEdges: 3 });
    expect(await store.getNodes(TEST_CORPUS_ID)).toHaveLength(0);
    expect(await store.getEdges(TEST_CORPUS_ID)).toHaveLength(0);
    expect(await store.getNodes(OTHER_CORPUS_ID)).toHaveLength(1);
    expect(await store.getEdges(OTHER_CORPUS_ID)).toHaveLength(1);
  });
});
