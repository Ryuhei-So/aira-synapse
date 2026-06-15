/**
 * Application Layer — LadybugDB-backed graph projection for PPR.
 * DES-LDB-005: IGraphProjection using IGraphStore (same pattern as SQLite).
 *
 * Entity-layer nodes are excluded from transitions to prevent
 * PageRank mass being trapped in the dense entity subgraph.
 */

import type { IGraphProjection, TransitionEntry } from '../../../domain/retrieval/ppr.js';
import type { IGraphStore } from '../../../domain/storage/graphStore.js';

export class LadybugGraphProjection implements IGraphProjection {
  constructor(private readonly graphStore: IGraphStore) {}

  async *getTransitions(corpusId: string): AsyncIterable<TransitionEntry> {
    const edges = await this.graphStore.getEdges(corpusId);
    for (const edge of edges) {
      if (
        edge.sourceNodeId.startsWith('entity:') ||
        edge.targetNodeId.startsWith('entity:')
      ) {
        continue;
      }
      yield {
        sourceNodeId: edge.sourceNodeId,
        targetNodeId: edge.targetNodeId,
        weight: edge.weight,
      };
    }
  }

  async getDanglingNodes(corpusId: string): Promise<readonly string[]> {
    const nodes = await this.graphStore.getNodes(corpusId);
    const edges = await this.graphStore.getEdges(corpusId);
    const withOutgoing = new Set(edges.map((e) => e.sourceNodeId));
    return nodes.filter((n) => !withOutgoing.has(n.nodeId)).map((n) => n.nodeId);
  }

  async getNodeCount(corpusId: string): Promise<number> {
    const nodes = await this.graphStore.getNodes(corpusId);
    return nodes.length;
  }
}
