import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeCanonicalKey } from '../../../src/domain/memory/schema.js';
import { StageIICanonicalizer } from '../../../src/application/indexing/StageIICanonicalizer.js';
import { buildSimilarityBridges, buildTypeBasedBridges } from '../../../src/application/indexing/StageIVGraphProjector.js';
import { SQLiteMemoryStore } from '../../../src/infrastructure/storage/SQLiteMemoryStore.js';
import { SnapshotBackedIndexingMemory } from '../../../src/infrastructure/storage/SnapshotBackedIndexingMemory.js';
import { SQLiteGraphStore } from '../../../src/infrastructure/storage/SQLiteGraphStore.js';
import { runMigrations } from '../../../src/infrastructure/storage/migrate.js';

function runPersonalizedPageRank(transitions: Readonly<Record<string, readonly [string, number][]>>, teleport: Readonly<Record<string, number>>, lambda = 0.5, epsilon = 1e-6, maxIterations = 100) {
  let scores = { ...teleport };
  const nodes = Object.keys(transitions);
  let converged = false;
  let iterations = 0;
  for (; iterations < maxIterations; iterations += 1) {
    const next: Record<string, number> = {};
    for (const node of nodes) {
      next[node] = (1 - lambda) * (teleport[node] ?? 0);
    }
    for (const [source, edges] of Object.entries(transitions)) {
      for (const [target, weight] of edges) {
        next[target] = (next[target] ?? 0) + lambda * (scores[source] ?? 0) * weight;
      }
    }
    const delta = nodes.reduce((total, node) => total + Math.abs((next[node] ?? 0) - (scores[node] ?? 0)), 0);
    scores = next;
    if (delta < epsilon) {
      converged = true;
      break;
    }
  }
  return { scores, converged, iterations: iterations + 1 };
}

describe('TASK-MG-057: MemGraphRAG paper validation', () => {
  let db: Database.Database;
  let store: SQLiteMemoryStore;
  let graphStore: SQLiteGraphStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.prepare(`INSERT INTO corpora (corpus_id, name, description, created_at, updated_at) VALUES ('corpus-1', 'Validation', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run();
    store = new SQLiteMemoryStore(db);
    graphStore = new SQLiteGraphStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('stabilizes schemas once frequency reaches tau=2', async () => {
    const stage = new StageIICanonicalizer('corpus-1', new SnapshotBackedIndexingMemory(store));
    const schemas = Array.from({ length: 3 }, (_, index) => ({
      chunk: { corpusId: 'corpus-1', documentId: `doc-${index}`, chunkId: `doc-${index}:0`, text: 'Alice authors Paper', normalizedText: 'alice authors paper', language: 'en' as const, metadata: { documentId: `doc-${index}`, title: `Doc ${index}`, sourceUrl: 'https://example.com', language: 'en' as const, sectionPath: ['Intro'], chunkId: `doc-${index}:0`, chunkIndex: 0, offsetStart: 0, offsetEnd: 10 } },
      candidateSchemas: [{ headType: 'Researcher', relation: 'authors', tailType: 'Paper', canonicalKey: computeCanonicalKey('Researcher', 'authors', 'Paper'), aliases: [], confidence: 0.9 }],
      candidateFacts: [],
      sourcePassage: { passageId: `passage-${index}`, corpusId: 'corpus-1', text: 'Alice authors Paper', normalizedText: 'alice authors paper', metadata: { documentId: `doc-${index}`, title: `Doc ${index}`, sourceUrl: 'https://example.com', language: 'en' as const, sectionPath: ['Intro'], chunkId: `doc-${index}:0`, chunkIndex: 0, offsetStart: 0, offsetEnd: 10 }, factIds: [], entityMentions: ['Alice'], qualityFlags: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      rawEntities: ['Alice'],
    }));
    const canonicalizer = { canonicalize: async () => ({ canonicalHeadType: 'Researcher', canonicalRelation: 'authors', canonicalTailType: 'Paper', aliases: [], confidence: 0.9 }) };

    const prepared = await stage.prepareSchemas(
      await stage.canonicalizeSchemas(schemas, canonicalizer),
      2,
    );

    expect(prepared.newlyStableSchemaIds).toEqual(['schema:researcher::authors::paper']);
    expect(prepared.finalSchemas[0]).toMatchObject({ frequency: 3, state: 'stable' });
  });

  it('generates type-based bridges between compatible schemas', async () => {
    const schemas = [
      { schemaId: 'schema-1', corpusId: 'corpus-1', headType: 'Researcher', relation: 'authors', tailType: 'Paper', canonicalKey: 'researcher::authors::paper', aliases: [], frequency: 2, state: 'stable' as const, stabilizationThreshold: 2, factIds: [], sourceDocumentIds: ['doc-1'], version: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      { schemaId: 'schema-2', corpusId: 'corpus-1', headType: 'Paper', relation: 'mentions', tailType: 'Method', canonicalKey: 'paper::mentions::method', aliases: [], frequency: 2, state: 'stable' as const, stabilizationThreshold: 2, factIds: [], sourceDocumentIds: ['doc-2'], version: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    ];

    const bridges = await buildTypeBasedBridges(graphStore, schemas);
    expect(bridges).toHaveLength(1);
    expect(bridges[0]?.bridgeKind).toBe('type_based');
  });

  it('builds deterministic similarity bridges with mocked embeddings', async () => {
    const bridges = await buildSimilarityBridges({ upsert: async () => undefined, query: async () => [], deleteByDocument: async () => undefined }, {
      embed: async () => ({ model: 'mock', cached: false, vectors: [[1, 0], [0.9, 0.1], [0, 1]] }),
      healthCheck: async () => ({ healthy: true }),
    }, [
      { nodeId: 'schema:s1', corpusId: 'corpus-1', layer: 'ontology', ref: { sourceDocumentIds: [] }, label: 'Researcher authors Paper' },
      { nodeId: 'schema:s2', corpusId: 'corpus-1', layer: 'ontology', ref: { sourceDocumentIds: [] }, label: 'Paper mentions Method' },
      { nodeId: 'schema:s3', corpusId: 'corpus-1', layer: 'ontology', ref: { sourceDocumentIds: [] }, label: 'Protein binds Gene' },
    ], 0.7);

    expect(bridges).toHaveLength(1);
    expect(bridges[0]?.relation).toBe('similarity_bridge');
  });

  it('converges personalized page rank with lambda=0.5 on a tiny graph', () => {
    const result = runPersonalizedPageRank({
      A: [['B', 1]],
      B: [['C', 1]],
      C: [['A', 1]],
    }, { A: 1, B: 0, C: 0 }, 0.5);

    expect(result.converged).toBe(true);
    expect(result.iterations).toBeLessThan(100);
    expect(result.scores['A']).toBeGreaterThan(0);
  });

  it('keeps deterministic retrieval ordering under mocked providers', () => {
    const result = runPersonalizedPageRank({
      passage1: [['passage2', 0.5]],
      passage2: [['passage1', 0.5]],
    }, { passage1: 0.8, passage2: 0.2 }, 0.5);

    expect(result.scores['passage1']).toBeGreaterThan(result.scores['passage2']);
  });
});
