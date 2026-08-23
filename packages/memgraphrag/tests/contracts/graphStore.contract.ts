/**
 * Contract test suite for IGraphStore implementations.
 * Any implementation (SQLite, LadybugDB) must pass all of these tests.
 */

import { it, expect, beforeEach, afterEach } from 'vitest';
import type { GraphEdge, GraphNode, IGraphStore } from '../../src/domain/storage/graphStore.js';
import type { Schema } from '../../src/domain/memory/schema.js';
import type { Fact } from '../../src/domain/memory/fact.js';
import type { Passage } from '../../src/domain/memory/passage.js';

const CORPUS = 'corpus-1';
const OTHER_CORPUS = 'corpus-2';
const DOC = 'doc-1';
const OTHER_DOC = 'doc-2';
const TS = '2025-01-01T00:00:00.000Z';

function createSchema(documentId = DOC): Schema {
  return {
    schemaId: `schema-${documentId}`, corpusId: CORPUS,
    headType: 'Author', relation: 'writes', tailType: 'Paper',
    canonicalKey: 'author::writes::paper',
    aliases: [{ label: 'Author writes Paper', language: 'en', source: 'manual', confidence: 1, isCanonical: true }],
    frequency: 2, state: 'stable', stabilizationThreshold: 2,
    factIds: [`fact-${documentId}`], sourceDocumentIds: [documentId],
    version: 1, createdAt: TS, updatedAt: TS,
  };
}

function createFact(documentId = DOC): Fact {
  return {
    factId: `fact-${documentId}`, corpusId: CORPUS, schemaId: `schema-${documentId}`,
    headEntity: 'Ada Lovelace', headType: 'Author', relation: 'writes',
    tailEntity: 'Notes', tailType: 'Paper', state: 'active',
    passageIds: [`passage-${documentId}`], sourceDocumentIds: [documentId],
    confidence: 0.98, temporalScope: '1843', createdAt: TS, updatedAt: TS,
  };
}

function createPassage(documentId = DOC): Passage {
  return {
    passageId: `passage-${documentId}`, corpusId: CORPUS,
    text: 'Ada Lovelace wrote notes on the Analytical Engine.',
    normalizedText: 'ada lovelace wrote notes on the analytical engine',
    metadata: {
      documentId, title: `Title ${documentId}`, sourceUrl: 'https://example.com/paper',
      sourceType: 'md', language: 'en', convertedAt: TS,
      sectionPath: ['Introduction'], chunkId: `chunk-${documentId}`,
      chunkIndex: 0, offsetStart: 0, offsetEnd: 52,
    },
    factIds: [`fact-${documentId}`], entityMentions: ['Ada Lovelace', 'Analytical Engine'],
    qualityFlags: [], qualityScore: 0.9, createdAt: TS, updatedAt: TS,
  };
}

function createNodes(): readonly GraphNode[] {
  return [
    { nodeId: 'schema-node-1', corpusId: CORPUS, layer: 'ontology', ref: createSchema(), label: 'Author writes Paper' },
    { nodeId: 'fact-node-1', corpusId: CORPUS, layer: 'fact', ref: createFact(), label: 'Ada writes Notes' },
    { nodeId: 'passage-node-1', corpusId: CORPUS, layer: 'passage', ref: createPassage(), label: 'Passage about Ada' },
  ];
}

function createEdges(): readonly GraphEdge[] {
  return [
    { edgeId: 'edge-1', corpusId: CORPUS, sourceNodeId: 'schema-node-1', targetNodeId: 'fact-node-1', relation: 'schema_instance', weight: 1 },
    { edgeId: 'edge-2', corpusId: CORPUS, sourceNodeId: 'fact-node-1', targetNodeId: 'passage-node-1', relation: 'fact_evidence', weight: 0.8 },
    { edgeId: 'edge-3', corpusId: CORPUS, sourceNodeId: 'schema-node-1', targetNodeId: 'passage-node-1', relation: 'similarity_bridge', weight: 0.5, bridgeKind: 'similarity_based' },
  ];
}

export interface GraphStoreFactory {
  create(): Promise<IGraphStore>;
  teardown(): Promise<void>;
}

export function graphStoreContractTests(factory: GraphStoreFactory): void {
  let store: IGraphStore;

  beforeEach(async () => { store = await factory.create(); });
  afterEach(async () => { await factory.teardown(); });

  it('upserts and retrieves nodes with refs intact', async () => {
    await store.upsertNodes(createNodes());
    const node = await store.getNode(CORPUS, 'schema-node-1');
    expect(node).not.toBeNull();
    expect(node).toMatchObject({ nodeId: 'schema-node-1', corpusId: CORPUS, layer: 'ontology', label: 'Author writes Paper' });
    expect(node?.ref).toMatchObject({ schemaId: 'schema-doc-1' });
  });

  it('upserts existing node (idempotent update)', async () => {
    await store.upsertNodes(createNodes());
    await store.upsertNodes([{ ...createNodes()[0]!, label: 'Updated label' }]);
    const updated = await store.getNode(CORPUS, 'schema-node-1');
    expect(updated?.label).toBe('Updated label');
  });

  it('returns null for missing node', async () => {
    const node = await store.getNode(CORPUS, 'nonexistent');
    expect(node).toBeNull();
  });

  it('filters nodes by corpus and layer', async () => {
    await store.upsertNodes(createNodes());
    await store.upsertNodes([{
      nodeId: 'other-node', corpusId: OTHER_CORPUS, layer: 'ontology',
      ref: { ...createSchema(), corpusId: OTHER_CORPUS }, label: 'Other',
    }]);

    expect(await store.getNodes(CORPUS, 'ontology')).toHaveLength(1);
    expect(await store.getNodes(CORPUS)).toHaveLength(3);
    expect(await store.getNodes(OTHER_CORPUS)).toHaveLength(1);
  });

  it('returns edges by source and adjacent edges', async () => {
    await store.upsertNodes(createNodes());
    await store.upsertEdges(createEdges());

    const outgoing = await store.getEdges(CORPUS, 'schema-node-1');
    expect(outgoing.map(e => e.edgeId).sort()).toEqual(['edge-1', 'edge-3']);

    const adjacent = await store.getAdjacent(CORPUS, 'fact-node-1');
    expect(adjacent.map(e => e.edgeId).sort()).toEqual(['edge-1', 'edge-2']);
  });

  it('deletes edges by id', async () => {
    await store.upsertNodes(createNodes());
    await store.upsertEdges(createEdges());

    const deleted = await store.deleteEdges(CORPUS, ['edge-3']);
    expect(deleted).toBe(1);
    expect(await store.getEdges(CORPUS)).toHaveLength(2);
  });

  it('deletes nodes and their incident edges', async () => {
    await store.upsertNodes(createNodes());
    await store.upsertEdges(createEdges());

    await store.deleteNodes(CORPUS, ['fact-node-1']);
    const nodes = await store.getNodes(CORPUS);
    const edges = await store.getEdges(CORPUS);

    expect(nodes.map(n => n.nodeId).sort()).toEqual(['passage-node-1', 'schema-node-1']);
    expect(edges).toHaveLength(1); // edge-3 remains
    expect(edges[0]?.edgeId).toBe('edge-3');
  });

  it('deletes by document', async () => {
    await store.upsertNodes([
      ...createNodes(),
      { nodeId: 'schema-node-2', corpusId: CORPUS, layer: 'ontology', ref: createSchema(OTHER_DOC), label: 'doc-2 schema' },
    ]);
    await store.upsertEdges([
      ...createEdges(),
      { edgeId: 'edge-4', corpusId: CORPUS, sourceNodeId: 'schema-node-2', targetNodeId: 'schema-node-2', relation: 'part_of', weight: 1 },
    ]);

    const result = await store.deleteByDocument(CORPUS, DOC);
    expect(result.deletedNodes).toBe(3);
    expect(result.deletedEdges).toBe(3);
    expect(await store.getNodes(CORPUS)).toHaveLength(1);
  });

  it('deletes by corpus (isolated)', async () => {
    await store.upsertNodes(createNodes());
    await store.upsertEdges(createEdges());
    await store.upsertNodes([{
      nodeId: 'other-n', corpusId: OTHER_CORPUS, layer: 'passage',
      ref: { ...createPassage(), corpusId: OTHER_CORPUS }, label: 'Other',
    }]);

    await store.deleteByCorpus(CORPUS);
    expect(await store.getNodes(CORPUS)).toHaveLength(0);
    expect(await store.getEdges(CORPUS)).toHaveLength(0);
    expect(await store.getNodes(OTHER_CORPUS)).toHaveLength(1);
  });

  // Edge case: cross-corpus isolation
  it('does not return nodes from other corpus', async () => {
    await store.upsertNodes(createNodes());
    expect(await store.getNode(OTHER_CORPUS, 'schema-node-1')).toBeNull();
  });

  it('does not return edges from other corpus', async () => {
    await store.upsertNodes(createNodes());
    await store.upsertEdges(createEdges());
    expect(await store.getEdges(OTHER_CORPUS)).toHaveLength(0);
    expect(await store.getAdjacent(OTHER_CORPUS, 'fact-node-1')).toHaveLength(0);
  });
}
