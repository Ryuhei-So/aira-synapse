import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { GraphNode, IEmbeddingProvider, IGraphStore, IVectorIndex } from '../../../../src/domain/index.js';
import { SQLiteGraphStore } from '../../../../src/infrastructure/storage/SQLiteGraphStore.js';
import { runMigrations } from '../../../../src/infrastructure/storage/migrate.js';
import { createNotImplementedStub } from '../../../setup/testDoubles.js';
import {
  projectGraph,
  buildTypeBasedBridges,
  buildSimilarityBridges,
  upsertVectors,
} from '../../../../src/application/indexing/StageIVGraphProjector.js';
import { DeleteDocumentService } from '../../../../src/application/indexing/DeleteDocumentService.js';

const now = '2026-01-01T00:00:00.000Z';

function createSchema(schemaId: string, headType = 'Person', tailType = 'Organization') {
  return {
    schemaId,
    corpusId: 'corpus-1',
    headType,
    relation: 'worksAt',
    tailType,
    canonicalKey: `${headType.toLowerCase()}::worksat::${tailType.toLowerCase()}`,
    aliases: [],
    frequency: 1,
    state: 'stable' as const,
    stabilizationThreshold: 2,
    factIds: ['fact-1'],
    sourceDocumentIds: ['doc-1'],
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function createFact(factId: string, schemaId: string) {
  return {
    factId,
    corpusId: 'corpus-1',
    schemaId,
    headEntity: 'Alice',
    headType: 'Person',
    relation: 'worksAt',
    tailEntity: 'ACME',
    tailType: 'Organization',
    state: 'active' as const,
    passageIds: ['passage-1'],
    sourceDocumentIds: ['doc-1'],
    confidence: 0.9,
    createdAt: now,
    updatedAt: now,
  };
}

function createPassage(passageId: string) {
  return {
    passageId,
    corpusId: 'corpus-1',
    text: 'Alice works at ACME',
    normalizedText: 'alice works at acme',
    metadata: {
      documentId: 'doc-1',
      title: 'Doc',
      sourceUrl: 'https://example.com',
      language: 'en' as const,
      sectionPath: ['Intro'],
      chunkId: 'doc-1:0',
      chunkIndex: 0,
      offsetStart: 0,
      offsetEnd: 10,
    },
    factIds: ['fact-1'],
    entityMentions: ['Alice', 'ACME'],
    qualityFlags: [],
    createdAt: now,
    updatedAt: now,
  };
}

describe('TASK-MG-033: StageIVGraphProjector', () => {
  let db: Database.Database;
  let graphStore: IGraphStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.prepare(`INSERT INTO corpora (corpus_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run('corpus-1', 'Corpus', '', now, now);
    db.prepare(`INSERT INTO documents (document_id, corpus_id, title, source_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`).run('doc-1', 'corpus-1', 'Doc', 'https://example.com', now, now);
    graphStore = new SQLiteGraphStore(db);
  });

  it('projects ontology, fact, and passage nodes with linking edges', async () => {
    const result = await projectGraph(graphStore, [createFact('fact-1', 'schema-1')], [createSchema('schema-1')], [createPassage('passage-1')]);
    const nodes = await graphStore.getNodes('corpus-1');
    const edges = await graphStore.getEdges('corpus-1');

    expect(result.nodes).toHaveLength(3);
    expect(nodes).toHaveLength(3);
    expect(edges.map((edge) => edge.relation)).toEqual(expect.arrayContaining(['schema_instance', 'fact_evidence']));
  });

  it('builds type-based bridges for schemas sharing normalized types', async () => {
    const bridges = await buildTypeBasedBridges(graphStore, [
      createSchema('schema-1', 'Person', 'Organization'),
      createSchema('schema-2', 'Person', 'Institution'),
      createSchema('schema-3', 'Molecule', 'Cell'),
    ]);

    expect(bridges).toHaveLength(1);
    expect(bridges[0]).toMatchObject({ relation: 'type_based_bridge', bridgeKind: 'type_based' });
  });

  it('builds similarity bridges from cosine similarity over embeddings', async () => {
    const vectorIndex = createNotImplementedStub<IVectorIndex>('IVectorIndex');
    const embeddingProvider = {
      ...createNotImplementedStub<IEmbeddingProvider>('IEmbeddingProvider'),
      embed: vi.fn<IEmbeddingProvider['embed']>().mockResolvedValue({
        model: 'test-embed',
        cached: false,
        vectors: [
          [1, 0, 0],
          [0.9, 0.1, 0],
          [0, 1, 0],
        ],
      }),
    } satisfies IEmbeddingProvider;

    const nodes: GraphNode[] = [
      { nodeId: 'schema:s1', corpusId: 'corpus-1', layer: 'ontology', ref: createSchema('schema-1'), label: 'Person worksAt Organization' },
      { nodeId: 'schema:s2', corpusId: 'corpus-1', layer: 'ontology', ref: createSchema('schema-2'), label: 'Person affiliatedWith Institution' },
      { nodeId: 'schema:s3', corpusId: 'corpus-1', layer: 'ontology', ref: createSchema('schema-3', 'Molecule', 'Cell'), label: 'Molecule binds Cell' },
    ];

    const bridges = await buildSimilarityBridges(vectorIndex, embeddingProvider, nodes, 0.7);

    expect(bridges).toHaveLength(1);
    expect(bridges[0]?.relation).toBe('similarity_bridge');
  });

  it('upserts vectors with layer-specific namespaces', async () => {
    const upsert = vi.fn<IVectorIndex['upsert']>().mockResolvedValue();
    const vectorIndex = {
      ...createNotImplementedStub<IVectorIndex>('IVectorIndex'),
      upsert,
    } satisfies IVectorIndex;
    const embeddingProvider = {
      ...createNotImplementedStub<IEmbeddingProvider>('IEmbeddingProvider'),
      embed: vi.fn<IEmbeddingProvider['embed']>().mockResolvedValue({ model: 'embed', cached: false, vectors: [[1, 0], [0, 1]] }),
    } satisfies IEmbeddingProvider;

    await upsertVectors(vectorIndex, embeddingProvider, [
      { nodeId: 'schema:s1', corpusId: 'corpus-1', layer: 'ontology', ref: createSchema('schema-1'), label: 'Schema label' },
      { nodeId: 'fact:f1', corpusId: 'corpus-1', layer: 'fact', ref: createFact('fact-1', 'schema-1'), label: 'Fact label' },
    ]);

    expect(upsert).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ id: 'schema:s1', namespace: 'schema' }),
      expect.objectContaining({ id: 'fact:f1', namespace: 'fact' }),
    ]));
  });

  it('deletes a document and adjusts linked schema frequency', async () => {
    db.prepare(`INSERT INTO schemas (schema_id, corpus_id, head_type, relation, tail_type, canonical_key, frequency, state, stabilization_threshold, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('schema-1', 'corpus-1', 'Person', 'worksAt', 'Organization', 'person::worksat::organization', 2, 'stable', 2, 1, now, now);
    db.prepare(`INSERT INTO facts (fact_id, corpus_id, schema_id, head_entity, head_type, relation, tail_entity, tail_type, state, confidence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('fact-1', 'corpus-1', 'schema-1', 'Alice', 'Person', 'worksAt', 'ACME', 'Organization', 'active', 0.9, now, now);
    db.prepare(`INSERT INTO fact_documents (fact_id, document_id) VALUES (?, ?)`).run('fact-1', 'doc-1');
    db.prepare(`INSERT INTO passages (passage_id, corpus_id, document_id, text, normalized_text, section_path, chunk_id, chunk_index, offset_start, offset_end, entity_mentions, quality_flags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('passage-1', 'corpus-1', 'doc-1', 'Alice works at ACME', 'alice works at acme', '[]', 'doc-1:0', 0, 0, 10, '[]', '[]', now, now);
    db.prepare(`INSERT INTO fact_passages (fact_id, passage_id) VALUES (?, ?)`).run('fact-1', 'passage-1');
    await graphStore.upsertNodes([
      { nodeId: 'schema:schema-1', corpusId: 'corpus-1', layer: 'ontology', ref: createSchema('schema-1'), label: 'schema' },
      { nodeId: 'fact:fact-1', corpusId: 'corpus-1', layer: 'fact', ref: createFact('fact-1', 'schema-1'), label: 'fact' },
      { nodeId: 'passage:passage-1', corpusId: 'corpus-1', layer: 'passage', ref: createPassage('passage-1'), label: 'passage' },
    ]);
    await graphStore.upsertEdges([{ edgeId: 'edge-1', corpusId: 'corpus-1', sourceNodeId: 'schema:schema-1', targetNodeId: 'fact:fact-1', relation: 'schema_instance', weight: 1 }]);

    const vectorIndex = {
      ...createNotImplementedStub<IVectorIndex>('IVectorIndex'),
      deleteByDocument: vi.fn<IVectorIndex['deleteByDocument']>().mockResolvedValue(),
    } satisfies IVectorIndex;
    const service = new DeleteDocumentService(db, graphStore, vectorIndex);

    const result = await service.deleteDocument('corpus-1', 'doc-1');
    const schemaRow = db.prepare('SELECT frequency, state FROM schemas WHERE schema_id = ?').get('schema-1') as { frequency: number; state: string };

    expect(result.deletedFacts).toBe(1);
    expect(result.deletedPassages).toBe(1);
    expect(result.deletedGraphNodes).toBeGreaterThan(0);
    expect(vectorIndex.deleteByDocument).toHaveBeenCalledWith('corpus-1', 'doc-1');
    expect(schemaRow.frequency).toBe(1);
    expect(schemaRow.state).toBe('pending');
  });
});
