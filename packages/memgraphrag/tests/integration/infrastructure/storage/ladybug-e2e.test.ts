/**
 * E2E Integration test — LadybugDB backend.
 * T-12: Full pipeline (store → query → retrieve) using LadybugDB adapters.
 *
 * Validates:
 * 1. All adapters created via storageFactory work together
 * 2. Graph + Vector + Memory + Lexical pipeline integration
 * 3. Close/dispose has no resource leaks
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createLadybugAdapters,
  type StorageAdapters,
} from '../../../../src/infrastructure/storage/ladybug/storageFactory.js';
import type { GraphNode, GraphEdge } from '../../../../src/domain/storage/graphStore.js';
import type { MemorySnapshot } from '../../../../src/domain/memory/globalMemory.js';
import type { Passage } from '../../../../src/domain/memory/passage.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CORPUS = 'e2e-test';
const TS = '2026-01-01T00:00:00.000Z';

function createTestPassages(): Passage[] {
  return [
    {
      passageId: 'p1', corpusId: CORPUS,
      text: 'Albert Einstein developed the theory of general relativity in 1915.',
      normalizedText: 'albert einstein developed the theory of general relativity in 1915',
      metadata: {
        documentId: 'doc-1', title: 'Relativity', sourceUrl: 'https://example.com/1',
        language: 'en', sectionPath: ['Physics'], chunkId: 'doc-1:0',
        chunkIndex: 0, offsetStart: 0, offsetEnd: 67,
      },
      factIds: ['f1'], entityMentions: ['Albert Einstein', 'general relativity'],
      qualityFlags: [], createdAt: TS, updatedAt: TS,
    },
    {
      passageId: 'p2', corpusId: CORPUS,
      text: 'General relativity describes the curvature of spacetime caused by mass and energy.',
      normalizedText: 'general relativity describes the curvature of spacetime caused by mass and energy',
      metadata: {
        documentId: 'doc-1', title: 'Relativity', sourceUrl: 'https://example.com/1',
        language: 'en', sectionPath: ['Physics'], chunkId: 'doc-1:1',
        chunkIndex: 1, offsetStart: 68, offsetEnd: 149,
      },
      factIds: ['f2'], entityMentions: ['general relativity', 'spacetime'],
      qualityFlags: [], createdAt: TS, updatedAt: TS,
    },
  ];
}

describe('LadybugDB E2E Integration', () => {
  let adapters: StorageAdapters;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ladybug-e2e-'));
    adapters = await createLadybugAdapters({ dbPath: join(dir, 'e2e.lbug') });
  });

  afterAll(async () => {
    if (adapters) await adapters.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('full pipeline: memory → graph → lexical → query', async () => {
    const passages = createTestPassages();

    // 1. Save memory snapshot
    const snapshot: MemorySnapshot = {
      corpusId: CORPUS, exportedAt: TS,
      schemas: [{
        schemaId: 's1', corpusId: CORPUS, headType: 'Person', relation: 'developed',
        tailType: 'Theory', canonicalKey: 'person::developed::theory',
        aliases: [], frequency: 1, state: 'stable', stabilizationThreshold: 2,
        factIds: ['f1'], sourceDocumentIds: ['doc-1'],
        version: 1, createdAt: TS, updatedAt: TS,
      }],
      facts: [{
        factId: 'f1', corpusId: CORPUS, schemaId: 's1',
        headEntity: 'Albert Einstein', headType: 'Person',
        relation: 'developed', tailEntity: 'general relativity', tailType: 'Theory',
        state: 'active', passageIds: ['p1'], sourceDocumentIds: ['doc-1'],
        confidence: 0.95, createdAt: TS, updatedAt: TS,
      }],
      passages,
      schemaVersion: 1,
    };
    await adapters.memoryStore.save(snapshot);

    // 2. Verify memory store round-trip
    const loaded = await adapters.memoryStore.load(CORPUS);
    expect(loaded.schemas).toHaveLength(1);
    expect(loaded.facts).toHaveLength(1);
    expect(loaded.passages).toHaveLength(2);

    // 3. Build graph
    const nodes: GraphNode[] = [
      { nodeId: 'schema-s1', corpusId: CORPUS, layer: 'ontology', ref: snapshot.schemas[0]!, label: 'Person developed Theory' },
      { nodeId: 'fact-f1', corpusId: CORPUS, layer: 'fact', ref: snapshot.facts[0]!, label: 'Einstein developed relativity' },
      { nodeId: 'passage-p1', corpusId: CORPUS, layer: 'passage', ref: passages[0]!, label: 'Einstein passage' },
      { nodeId: 'passage-p2', corpusId: CORPUS, layer: 'passage', ref: passages[1]!, label: 'Relativity passage' },
    ];
    const edges: GraphEdge[] = [
      { edgeId: 'e1', corpusId: CORPUS, sourceNodeId: 'schema-s1', targetNodeId: 'fact-f1', relation: 'schema_instance', weight: 1.0 },
      { edgeId: 'e2', corpusId: CORPUS, sourceNodeId: 'fact-f1', targetNodeId: 'passage-p1', relation: 'fact_evidence', weight: 0.9 },
      { edgeId: 'e3', corpusId: CORPUS, sourceNodeId: 'fact-f1', targetNodeId: 'passage-p2', relation: 'fact_evidence', weight: 0.8 },
    ];
    await adapters.graphStore.upsertNodes(nodes);
    await adapters.graphStore.upsertEdges(edges);

    // 4. Verify graph
    const allNodes = await adapters.graphStore.getNodes(CORPUS);
    expect(allNodes).toHaveLength(4);
    const allEdges = await adapters.graphStore.getEdges(CORPUS);
    expect(allEdges).toHaveLength(3);

    // 5. Graph projection for PPR
    let transitionCount = 0;
    for await (const _t of adapters.graphProjection.getTransitions(CORPUS)) {
      transitionCount++;
    }
    expect(transitionCount).toBe(3);
    expect(await adapters.graphProjection.getNodeCount(CORPUS)).toBe(4);

    // 6. Lexical retrieval
    await adapters.lexicalRetriever.indexPassages(CORPUS, passages);
    const lexResults = await adapters.lexicalRetriever.search(CORPUS, 'Einstein relativity', 5);
    expect(lexResults.length).toBeGreaterThan(0);

    // 7. Memory integrity
    const errors = await adapters.memoryStore.validateIntegrity(CORPUS);
    expect(errors).toHaveLength(0);
  });

  it('document deletion cascades across graph and lexical stores', async () => {
    // Delete doc-1 from graph store
    const deleteResult = await adapters.graphStore.deleteByDocument(CORPUS, 'doc-1');
    expect(deleteResult.deletedNodes).toBeGreaterThan(0);

    // Verify graph nodes are gone
    const remaining = await adapters.graphStore.getNodes(CORPUS);
    expect(remaining).toHaveLength(0);

    // Verify edges are gone
    const remainingEdges = await adapters.graphStore.getEdges(CORPUS);
    expect(remainingEdges).toHaveLength(0);

    // Delete passages from lexical index
    await adapters.lexicalRetriever.deleteByDocument(CORPUS, 'doc-1');

    // Search for a term only in passages (not in fact entities)
    // "curvature" appears only in passage text, not in fact head/tail entities
    const lexAfterPassage = await adapters.lexicalRetriever.search(CORPUS, 'curvature spacetime', 5);
    // After passage deletion, passage FTS should not find "curvature"
    // FactNode FTS searches head_entity/tail_entity which don't contain "curvature"
    expect(lexAfterPassage).toHaveLength(0);
  });

  it('job checkpoint round-trip', async () => {
    await adapters.memoryStore.saveCheckpoint({
      jobId: 'job-e2e', corpusId: CORPUS,
      processedDocumentIds: ['doc-1', 'doc-2'],
      updatedAt: TS,
    });
    const cp = await adapters.memoryStore.loadCheckpoint('job-e2e');
    expect(cp).toBeDefined();
    expect(cp!.processedDocumentIds).toEqual(['doc-1', 'doc-2']);
  });
});

describe('LadybugDB close/dispose', () => {
  it('close() releases all resources without errors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ladybug-close-'));
    try {
      const adapters = await createLadybugAdapters({ dbPath: join(dir, 'close.lbug') });

      // Use adapters
      await adapters.graphStore.upsertNodes([{
        nodeId: 'n1', corpusId: 'c1', layer: 'fact', ref: {}, label: 'test',
      }]);

      // Close should not throw
      await expect(adapters.close()).resolves.toBeUndefined();

      // Operations after close should fail gracefully (pool is drained)
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('double close is safe', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ladybug-dblclose-'));
    try {
      const adapters = await createLadybugAdapters({ dbPath: join(dir, 'test.lbug') });
      await adapters.close();
      // Second close should be idempotent
      await expect(adapters.close()).resolves.toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
