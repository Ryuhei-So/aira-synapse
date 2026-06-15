/**
 * Tests for SQLite → LadybugDB migration (T-10).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LadybugConnectionPool } from '../../../../src/infrastructure/storage/ladybug/LadybugConnection.js';
import { LadybugGraphStore } from '../../../../src/infrastructure/storage/ladybug/LadybugGraphStore.js';
import { LadybugMemoryStore } from '../../../../src/infrastructure/storage/ladybug/LadybugMemoryStore.js';
import { LadybugLexicalRetriever } from '../../../../src/infrastructure/storage/ladybug/LadybugLexicalRetriever.js';
import { LadybugVectorIndex } from '../../../../src/infrastructure/storage/ladybug/LadybugVectorIndex.js';
import { migrateCorpus, formatMigrationReport } from '../../../../src/infrastructure/storage/ladybug/migration.js';
import type { IGraphStore, IVectorIndex, IMemoryStore, GraphNode, GraphEdge } from '../../../../src/domain/storage/graphStore.js';
import type { ILexicalRetriever } from '../../../../src/domain/retrieval/ppr.js';
import type { MemorySnapshot } from '../../../../src/domain/memory/globalMemory.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// In-memory source implementation for testing migration
class InMemoryGraphStore implements IGraphStore {
  private nodes: GraphNode[] = [];
  private edges: GraphEdge[] = [];

  addNodes(nodes: GraphNode[]) { this.nodes.push(...nodes); }
  addEdges(edges: GraphEdge[]) { this.edges.push(...edges); }

  async upsertNodes(nodes: readonly GraphNode[]) { this.nodes.push(...nodes); }
  async upsertEdges(edges: readonly GraphEdge[]) { this.edges.push(...edges); }
  async getNode(corpusId: string, nodeId: string) {
    return this.nodes.find(n => n.corpusId === corpusId && n.nodeId === nodeId) ?? null;
  }
  async getNodes(corpusId: string) {
    return this.nodes.filter(n => n.corpusId === corpusId);
  }
  async getAdjacent() { return []; }
  async getEdges(corpusId: string) {
    return this.edges.filter(e => e.corpusId === corpusId);
  }
  async deleteNodes() { return 0; }
  async deleteEdges() { return 0; }
  async deleteByDocument() { return { deletedNodes: 0, deletedEdges: 0 }; }
  async deleteByCorpus() { return { deletedNodes: 0, deletedEdges: 0 }; }
}

class InMemoryMemoryStore implements IMemoryStore {
  private snapshots = new Map<string, MemorySnapshot>();

  setSnapshot(snap: MemorySnapshot) { this.snapshots.set(snap.corpusId, snap); }

  async load(corpusId: string) {
    return this.snapshots.get(corpusId) ?? {
      corpusId, exportedAt: '', schemas: [], facts: [], passages: [], schemaVersion: 1,
    };
  }
  async save(snap: MemorySnapshot) { this.snapshots.set(snap.corpusId, snap); }
  async saveCheckpoint() {}
  async loadCheckpoint() { return null; }
  async validateIntegrity() { return []; }
}

class InMemoryVectorIndex implements IVectorIndex {
  async upsert() {}
  async search() { return []; }
  async deleteByDocument() {}
}

class InMemoryLexicalRetriever implements ILexicalRetriever {
  async indexPassages() {}
  async search() { return []; }
  async deleteByDocument() {}
}

describe('migration (T-10)', () => {
  let pool: LadybugConnectionPool;
  let dir: string;

  const CORPUS = 'test-corpus';

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ladybug-mig-'));
    pool = new LadybugConnectionPool(join(dir, 'test.lbug'));
    await pool.init();
  });

  afterAll(async () => {
    if (pool) await pool.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('migrates nodes, edges, and memory snapshot', async () => {
    // Setup source with test data
    const srcGraph = new InMemoryGraphStore();
    srcGraph.addNodes([
      { nodeId: 'n1', corpusId: CORPUS, layer: 'fact', ref: { factId: 'f1' }, label: 'Fact 1' },
      { nodeId: 'n2', corpusId: CORPUS, layer: 'passage', ref: { passageId: 'p1' }, label: 'Passage 1' },
    ]);
    srcGraph.addEdges([
      { edgeId: 'e1', corpusId: CORPUS, sourceNodeId: 'n1', targetNodeId: 'n2', relation: 'fact_evidence', weight: 0.9 },
    ]);

    const srcMemory = new InMemoryMemoryStore();
    srcMemory.setSnapshot({
      corpusId: CORPUS,
      exportedAt: '2026-01-01T00:00:00.000Z',
      schemas: [{
        schemaId: 's1', corpusId: CORPUS, headType: 'A', relation: 'r', tailType: 'B',
        canonicalKey: 'a::r::b', aliases: [], frequency: 1, state: 'stable',
        stabilizationThreshold: 2, factIds: ['f1'], sourceDocumentIds: ['doc-1'],
        version: 1, createdAt: '', updatedAt: '',
      }],
      facts: [{
        factId: 'f1', corpusId: CORPUS, schemaId: 's1', headEntity: 'X', headType: 'A',
        relation: 'r', tailEntity: 'Y', tailType: 'B', state: 'active',
        passageIds: ['p1'], sourceDocumentIds: ['doc-1'], confidence: 0.9,
        createdAt: '', updatedAt: '',
      }],
      passages: [{
        passageId: 'p1', corpusId: CORPUS, text: 'Test passage about X and Y',
        normalizedText: 'test passage about x and y',
        metadata: { documentId: 'doc-1', title: 'Test', sourceUrl: 'https://example.com',
          language: 'en', sectionPath: [], chunkId: 'c1', chunkIndex: 0, offsetStart: 0, offsetEnd: 26 },
        factIds: ['f1'], entityMentions: ['X', 'Y'], qualityFlags: [],
        createdAt: '', updatedAt: '',
      }],
      schemaVersion: 1,
    });

    const source = {
      graphStore: srcGraph,
      vectorIndex: new InMemoryVectorIndex(),
      memoryStore: srcMemory,
      lexicalRetriever: new InMemoryLexicalRetriever(),
    };

    const target = {
      graphStore: new LadybugGraphStore(pool),
      vectorIndex: new LadybugVectorIndex(pool),
      memoryStore: new LadybugMemoryStore(pool),
      lexicalRetriever: new LadybugLexicalRetriever(pool),
    };

    const report = await migrateCorpus(CORPUS, source, target);

    expect(report.errors).toHaveLength(0);
    expect(report.nodes.source).toBe(2);
    expect(report.nodes.target).toBe(2);
    expect(report.edges.source).toBe(1);
    expect(report.edges.target).toBe(1);
    expect(report.schemas.source).toBe(1);
    expect(report.schemas.target).toBe(1);
    expect(report.facts.source).toBe(1);
    expect(report.facts.target).toBe(1);
    expect(report.passages.source).toBe(1);
    expect(report.passages.target).toBe(1);
  });

  it('is idempotent (re-run produces same counts)', async () => {
    // Clean target
    await pool.query('MATCH (n:GNode) DETACH DELETE n');
    await pool.query('MATCH (n:SchemaNode) DELETE n');
    await pool.query('MATCH (n:FactNode) DELETE n');
    await pool.query('MATCH (n:PassageNode) DELETE n');

    const srcGraph = new InMemoryGraphStore();
    srcGraph.addNodes([
      { nodeId: 'x1', corpusId: CORPUS, layer: 'fact', ref: {}, label: 'X1' },
    ]);
    const srcMemory = new InMemoryMemoryStore();
    srcMemory.setSnapshot({
      corpusId: CORPUS, exportedAt: '', schemas: [], facts: [], passages: [], schemaVersion: 1,
    });

    const source = {
      graphStore: srcGraph, vectorIndex: new InMemoryVectorIndex(),
      memoryStore: srcMemory, lexicalRetriever: new InMemoryLexicalRetriever(),
    };
    const target = {
      graphStore: new LadybugGraphStore(pool), vectorIndex: new LadybugVectorIndex(pool),
      memoryStore: new LadybugMemoryStore(pool), lexicalRetriever: new LadybugLexicalRetriever(pool),
    };

    const r1 = await migrateCorpus(CORPUS, source, target);
    const r2 = await migrateCorpus(CORPUS, source, target);

    expect(r1.nodes.target).toBe(r2.nodes.target);
  });

  it('formats migration report', () => {
    const report = {
      corpusId: 'test', nodes: { source: 10, target: 10 },
      edges: { source: 5, target: 5 }, schemas: { source: 3, target: 3 },
      facts: { source: 7, target: 7 }, passages: { source: 4, target: 4 },
      durationMs: 123, errors: [],
    };
    const formatted = formatMigrationReport(report);
    expect(formatted).toContain('✅');
    expect(formatted).toContain('test');
    expect(formatted).toContain('123ms');
  });
});
