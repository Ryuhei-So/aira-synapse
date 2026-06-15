/**
 * Tests for LadybugMultiHopTraversal.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LadybugConnectionPool } from '../../../../src/infrastructure/storage/ladybug/LadybugConnection.js';
import { LadybugGraphStore } from '../../../../src/infrastructure/storage/ladybug/LadybugGraphStore.js';
import { LadybugMultiHopTraversal } from '../../../../src/infrastructure/storage/ladybug/LadybugMultiHopTraversal.js';
import type { GraphNode, GraphEdge } from '../../../../src/domain/storage/graphStore.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('LadybugMultiHopTraversal', () => {
  let pool: LadybugConnectionPool;
  let graphStore: LadybugGraphStore;
  let traversal: LadybugMultiHopTraversal;
  let dir: string;

  const CORPUS = 'test-corpus';

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ladybug-mh-'));
    pool = new LadybugConnectionPool(join(dir, 'test.lbug'));
    await pool.init();
    graphStore = new LadybugGraphStore(pool);
    traversal = new LadybugMultiHopTraversal(pool);

    // Build test graph:
    // schema-1 --schema_instance--> fact-1 --fact_evidence--> passage-1
    //                                  |
    //                          entity_mention
    //                                  |
    //                             entity:ada (excluded)
    //
    // fact-1 --similarity_bridge--> fact-2 --fact_evidence--> passage-2
    const nodes: GraphNode[] = [
      { nodeId: 'schema-1', corpusId: CORPUS, layer: 'ontology', ref: {}, label: 'Schema 1' },
      { nodeId: 'fact-1', corpusId: CORPUS, layer: 'fact', ref: {}, label: 'Fact 1' },
      { nodeId: 'fact-2', corpusId: CORPUS, layer: 'fact', ref: {}, label: 'Fact 2' },
      { nodeId: 'passage-1', corpusId: CORPUS, layer: 'passage', ref: {}, label: 'Passage 1' },
      { nodeId: 'passage-2', corpusId: CORPUS, layer: 'passage', ref: {}, label: 'Passage 2' },
      { nodeId: 'entity:ada', corpusId: CORPUS, layer: 'entity', ref: {}, label: 'Ada' },
    ];
    const edges: GraphEdge[] = [
      { edgeId: 'e1', corpusId: CORPUS, sourceNodeId: 'schema-1', targetNodeId: 'fact-1', relation: 'schema_instance', weight: 1.0 },
      { edgeId: 'e2', corpusId: CORPUS, sourceNodeId: 'fact-1', targetNodeId: 'passage-1', relation: 'fact_evidence', weight: 0.9 },
      { edgeId: 'e3', corpusId: CORPUS, sourceNodeId: 'fact-1', targetNodeId: 'fact-2', relation: 'similarity_bridge', weight: 0.7, bridgeKind: 'similarity_based' },
      { edgeId: 'e4', corpusId: CORPUS, sourceNodeId: 'fact-2', targetNodeId: 'passage-2', relation: 'fact_evidence', weight: 0.8 },
      { edgeId: 'e5', corpusId: CORPUS, sourceNodeId: 'entity:ada', targetNodeId: 'fact-1', relation: 'entity_mention', weight: 0.5 },
    ];
    await graphStore.upsertNodes(nodes);
    await graphStore.upsertEdges(edges);
  });

  afterAll(async () => {
    if (pool) await pool.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns empty for no seeds', async () => {
    const results = await traversal.traverse(CORPUS, []);
    expect(results).toHaveLength(0);
  });

  it('discovers 1-hop neighbors', async () => {
    const results = await traversal.traverse(CORPUS, ['schema-1'], { maxHops: 1 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some(r => r.nodeId === 'fact-1')).toBe(true);
  });

  it('discovers multi-hop paths', async () => {
    const results = await traversal.traverse(CORPUS, ['schema-1'], { maxHops: 3 });
    // Should reach passage-1 (2 hops), fact-2 (2 hops), passage-2 (3 hops)
    const nodeIds = results.map(r => r.nodeId);
    expect(nodeIds).toContain('fact-1');
    expect(nodeIds).toContain('passage-1');
  });

  it('excludes entity-layer nodes', async () => {
    const results = await traversal.traverse(CORPUS, ['fact-1'], { maxHops: 3 });
    const layers = results.map(r => r.layer);
    expect(layers).not.toContain('entity');
    expect(results.every(r => !r.nodeId.startsWith('entity:'))).toBe(true);
  });

  it('applies relation filter', async () => {
    const results = await traversal.traverse(CORPUS, ['fact-1'], {
      maxHops: 2,
      relationFilter: ['fact_evidence'],
    });
    // Only fact_evidence edges should be followed
    const nodeIds = results.map(r => r.nodeId);
    expect(nodeIds).toContain('passage-1');
    // fact-2 is connected via similarity_bridge, should be excluded
    expect(nodeIds).not.toContain('fact-2');
  });

  it('applies minWeight filter', async () => {
    const results = await traversal.traverse(CORPUS, ['fact-1'], {
      maxHops: 2,
      minWeight: 0.8,
    });
    // e2 (weight 0.9) should pass, e3 (weight 0.7) should not
    const nodeIds = results.map(r => r.nodeId);
    expect(nodeIds).toContain('passage-1');
    expect(nodeIds).not.toContain('fact-2');
  });

  it('computes path weight as product', async () => {
    const results = await traversal.traverse(CORPUS, ['schema-1'], { maxHops: 2 });
    const passage1 = results.find(r => r.nodeId === 'passage-1');
    // schema-1 -> fact-1 (1.0) -> passage-1 (0.9) = 0.9
    expect(passage1).toBeDefined();
    expect(passage1!.pathWeight).toBeCloseTo(0.9, 2);
  });

  it('respects topK limit', async () => {
    const results = await traversal.traverse(CORPUS, ['schema-1'], { maxHops: 3, topK: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });
});
