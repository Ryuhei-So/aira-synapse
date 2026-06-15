/**
 * Run IGraphProjection contract tests against LadybugGraphProjection.
 * Single shared pool to avoid Mmap exhaustion.
 */

import { describe, beforeAll, afterAll } from 'vitest';
import { LadybugConnectionPool } from '../../../src/infrastructure/storage/ladybug/LadybugConnection.js';
import { LadybugGraphStore } from '../../../src/infrastructure/storage/ladybug/LadybugGraphStore.js';
import { LadybugGraphProjection } from '../../../src/infrastructure/storage/ladybug/LadybugGraphProjection.js';
import { graphProjectionContractTests } from '../graphProjection.contract.js';
import type { GraphNode, GraphEdge } from '../../../src/domain/storage/graphStore.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('IGraphProjection contract — LadybugGraphProjection', () => {
  let pool: LadybugConnectionPool;
  let dir: string;
  let graphStore: LadybugGraphStore;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ladybug-gp-'));
    pool = new LadybugConnectionPool(join(dir, 'test.lbug'));
    await pool.init();
    graphStore = new LadybugGraphStore(pool);
  });

  afterAll(async () => {
    if (pool) await pool.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  graphProjectionContractTests({
    async create() {
      try { await pool.query('MATCH (n:GNode) DETACH DELETE n'); } catch { /* ignore */ }
      return new LadybugGraphProjection(graphStore);
    },
    async teardown() {
      // no-op — pool is shared
    },
    async seedGraph(corpusId: string) {
      const nodes: GraphNode[] = [
        { nodeId: 'schema-1', corpusId, layer: 'ontology', ref: {}, label: 'Author writes Paper' },
        { nodeId: 'fact-1', corpusId, layer: 'fact', ref: {}, label: 'Ada writes Notes' },
        { nodeId: 'passage-1', corpusId, layer: 'passage', ref: {}, label: 'Passage 1' },
        { nodeId: 'entity:ada', corpusId, layer: 'entity', ref: {}, label: 'Ada Lovelace' },
      ];
      const edges: GraphEdge[] = [
        { edgeId: 'e1', corpusId, sourceNodeId: 'schema-1', targetNodeId: 'fact-1', relation: 'schema_instance', weight: 1 },
        { edgeId: 'e2', corpusId, sourceNodeId: 'fact-1', targetNodeId: 'passage-1', relation: 'fact_evidence', weight: 0.8 },
        // This entity edge should be excluded from transitions
        { edgeId: 'e3', corpusId, sourceNodeId: 'entity:ada', targetNodeId: 'fact-1', relation: 'entity_mention', weight: 0.5 },
      ];
      await graphStore.upsertNodes(nodes);
      await graphStore.upsertEdges(edges);
    },
  });
});
