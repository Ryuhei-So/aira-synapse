/**
 * Infrastructure Layer — Neo4j-backed graph projection for PPR.
 * Same pattern as LadybugDB/SQLite: delegates to IGraphStore.
 * Entity-layer nodes excluded from transitions.
 */

import type { IGraphProjection, TransitionEntry } from '../../../domain/retrieval/ppr.js';
import type { IGraphStore } from '../../../domain/storage/graphStore.js';

export class Neo4jGraphProjection implements IGraphProjection {
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
