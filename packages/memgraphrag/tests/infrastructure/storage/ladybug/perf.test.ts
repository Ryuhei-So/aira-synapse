/**
 * Performance validation for LadybugDB adapters (T-14).
 * Measures actual latency for all adapter operations with assertions.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LadybugConnectionPool } from '../../../../src/infrastructure/storage/ladybug/LadybugConnection.js';
import { LadybugGraphStore } from '../../../../src/infrastructure/storage/ladybug/LadybugGraphStore.js';
import { LadybugVectorIndex } from '../../../../src/infrastructure/storage/ladybug/LadybugVectorIndex.js';
import { LadybugMemoryStore } from '../../../../src/infrastructure/storage/ladybug/LadybugMemoryStore.js';
import { LadybugLexicalRetriever } from '../../../../src/infrastructure/storage/ladybug/LadybugLexicalRetriever.js';
import { LadybugGraphProjection } from '../../../../src/infrastructure/storage/ladybug/LadybugGraphProjection.js';
import { LadybugMultiHopTraversal } from '../../../../src/infrastructure/storage/ladybug/LadybugMultiHopTraversal.js';
import type { GraphNode, GraphEdge } from '../../../../src/domain/storage/graphStore.js';
import type { Passage } from '../../../../src/domain/memory/passage.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CORPUS = 'perf-test';
const TS = '2026-01-01T00:00:00.000Z';

function randomVec(): number[] {
  const v = new Array(1536);
  for (let i = 0; i < 1536; i++) v[i] = Math.random() - 0.5;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map(x => x / norm);
}

function makeNode(id: number): GraphNode {
  return {
    nodeId: `node-${id}`, corpusId: CORPUS, layer: 'fact',
    ref: { factId: `f-${id}` }, label: `Fact ${id}`,
  };
}

function makeEdge(id: number, src: number, tgt: number): GraphEdge {
  return {
    edgeId: `edge-${id}`, corpusId: CORPUS,
    sourceNodeId: `node-${src}`, targetNodeId: `node-${tgt}`,
    relation: 'fact_evidence', weight: Math.random() * 0.5 + 0.5,
  };
}

function makePassage(id: number): Passage {
  return {
    passageId: `p-${id}`, corpusId: CORPUS,
    text: `This is passage ${id} about topic ${id % 10}. It discusses various aspects of subject ${id % 5} in the context of domain ${id % 3}.`,
    normalizedText: `this is passage ${id} about topic ${id % 10}`,
    metadata: {
      documentId: `doc-${id % 20}`, title: `Doc ${id % 20}`,
      sourceUrl: `https://example.com/${id}`, language: 'en',
      sectionPath: [], chunkId: `c-${id}`, chunkIndex: 0,
      offsetStart: 0, offsetEnd: 100,
    },
    factIds: [`f-${id}`], entityMentions: [`entity-${id % 10}`],
    qualityFlags: [], createdAt: TS, updatedAt: TS,
  };
}

async function measure<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = performance.now();
  const result = await fn();
  return { result, ms: performance.now() - start };
}

describe('LadybugDB Performance Validation (T-14)', () => {
  let pool: LadybugConnectionPool;
  let graphStore: LadybugGraphStore;
  let vectorIndex: LadybugVectorIndex;
  let memoryStore: LadybugMemoryStore;
  let lexicalRetriever: LadybugLexicalRetriever;
  let projection: LadybugGraphProjection;
  let traversal: LadybugMultiHopTraversal;
  let dir: string;

  const report: Record<string, { ms: number; description: string }> = {};

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ladybug-perf-'));
    pool = new LadybugConnectionPool(join(dir, 'perf.lbug'), 1536);
    await pool.init();
    graphStore = new LadybugGraphStore(pool);
    vectorIndex = new LadybugVectorIndex(pool);
    memoryStore = new LadybugMemoryStore(pool);
    lexicalRetriever = new LadybugLexicalRetriever(pool);
    projection = new LadybugGraphProjection(graphStore);
    traversal = new LadybugMultiHopTraversal(pool);
  });

  afterAll(async () => {
    // Print performance report
    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║         LadybugDB Performance Report (T-14)                 ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    for (const [name, { ms, description }] of Object.entries(report)) {
      const msStr = ms.toFixed(1).padStart(8);
      console.log(`║ ${msStr}ms │ ${description.padEnd(46)} ║`);
    }
    console.log('╚══════════════════════════════════════════════════════════════╝');

    if (pool) await pool.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('bulk insert: 500 nodes < 5s', async () => {
    const nodes = Array.from({ length: 500 }, (_, i) => makeNode(i));
    const { ms } = await measure(() => graphStore.upsertNodes(nodes));
    report['node-insert'] = { ms, description: `Insert 500 nodes` };
    expect(ms).toBeLessThan(5000);
  });

  it('bulk insert: 1000 edges < 10s', async () => {
    const edges: GraphEdge[] = [];
    for (let i = 0; i < 1000; i++) {
      edges.push(makeEdge(i, i % 500, (i + 1 + Math.floor(Math.random() * 20)) % 500));
    }
    const { ms } = await measure(() => graphStore.upsertEdges(edges));
    report['edge-insert'] = { ms, description: `Insert 1000 edges` };
    expect(ms).toBeLessThan(10000);
  });

  it('single node lookup < 50ms', async () => {
    const { ms, result } = await measure(() => graphStore.getNode(CORPUS, 'node-42'));
    report['node-lookup'] = { ms, description: `Single node lookup` };
    expect(result).not.toBeNull();
    expect(ms).toBeLessThan(50);
  });

  it('get all 500 nodes < 500ms', async () => {
    const { ms, result } = await measure(() => graphStore.getNodes(CORPUS));
    report['nodes-all'] = { ms, description: `Get all 500 nodes` };
    expect(result.length).toBe(500);
    expect(ms).toBeLessThan(500);
  });

  it('get all 1000 edges < 500ms', async () => {
    const { ms, result } = await measure(() => graphStore.getEdges(CORPUS));
    report['edges-all'] = { ms, description: `Get all 1000 edges` };
    expect(result.length).toBe(1000);
    expect(ms).toBeLessThan(500);
  });

  it('adjacent edges < 100ms', async () => {
    const { ms, result } = await measure(() => graphStore.getAdjacent(CORPUS, 'node-10'));
    report['adjacent'] = { ms, description: `Adjacent edges for 1 node` };
    expect(result.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(100);
  });

  it('insert 100 vectors < 5s', async () => {
    const vectors = Array.from({ length: 100 }, (_, i) => ({
      id: `vec-${i}`, corpusId: CORPUS, namespace: 'fact' as const,
      values: randomVec(), metadata: { documentId: `doc-${i % 20}` },
    }));
    const { ms } = await measure(() => vectorIndex.upsert(vectors));
    report['vec-insert'] = { ms, description: `Insert 100 vectors (1536-dim)` };
    expect(ms).toBeLessThan(5000);
  });

  it('vector search top-10 < 200ms', async () => {
    const { ms, result } = await measure(() =>
      vectorIndex.search({
        corpusId: CORPUS, namespace: 'fact',
        queryVector: randomVec(), topK: 10,
      }),
    );
    report['vec-search'] = { ms, description: `HNSW vector search top-10` };
    expect(result.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(200);
  });

  it('index 200 passages < 5s', async () => {
    const passages = Array.from({ length: 200 }, (_, i) => makePassage(i));
    const { ms } = await measure(() => lexicalRetriever.indexPassages(CORPUS, passages));
    report['passage-index'] = { ms, description: `Index 200 passages (FTS)` };
    expect(ms).toBeLessThan(5000);
  });

  it('FTS search top-10 < 100ms', async () => {
    const { ms, result } = await measure(() =>
      lexicalRetriever.search(CORPUS, 'topic aspect domain', 10),
    );
    report['fts-search'] = { ms, description: `FTS search top-10` };
    expect(result.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(100);
  });

  it('memory store save+load < 3s', async () => {
    const passages = Array.from({ length: 100 }, (_, i) => makePassage(i));
    const snapshot = {
      corpusId: CORPUS, exportedAt: TS, schemas: [], facts: [],
      passages, schemaVersion: 1,
    };
    const { ms: saveMs } = await measure(() => memoryStore.save(snapshot));
    const { ms: loadMs, result } = await measure(() => memoryStore.load(CORPUS));
    report['memory-save'] = { ms: saveMs, description: `Memory save (100 passages)` };
    report['memory-load'] = { ms: loadMs, description: `Memory load (100 passages)` };
    expect(result.passages.length).toBeGreaterThanOrEqual(100);
    expect(saveMs + loadMs).toBeLessThan(3000);
  });

  it('graph projection iterate < 500ms', async () => {
    let count = 0;
    const { ms } = await measure(async () => {
      for await (const _t of projection.getTransitions(CORPUS)) count++;
    });
    report['projection'] = { ms, description: `Projection iterate (${count} transitions)` };
    expect(count).toBeGreaterThan(0);
    expect(ms).toBeLessThan(500);
  });

  it('multi-hop traversal 2 hops < 1s', async () => {
    const { ms, result } = await measure(() =>
      traversal.traverse(CORPUS, ['node-0'], { maxHops: 2, topK: 20 }),
    );
    report['multihop'] = { ms, description: `MultiHop traversal 2-hop` };
    expect(result.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(1000);
  });

  it('deleteByCorpus < 5s', async () => {
    const { ms, result } = await measure(() => graphStore.deleteByCorpus(CORPUS));
    report['delete-corpus'] = { ms, description: `Delete corpus (500n + 1000e)` };
    expect(result.deletedNodes).toBe(500);
    expect(ms).toBeLessThan(5000);
  });
});
