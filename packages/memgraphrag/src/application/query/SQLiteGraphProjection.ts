/**
 * SQLite-backed Graph Projection for PPR.
 * Iterates graph edges as transition probabilities.
 */
import type { IGraphProjection, TransitionEntry } from '../../domain/retrieval/ppr.js';
import type { IGraphStore } from '../../domain/storage/index.js';

export class SQLiteGraphProjection implements IGraphProjection {
  constructor(private readonly graphStore: IGraphStore) {}

  public async *getTransitions(corpusId: string): AsyncIterable<TransitionEntry> {
    const edges = await this.graphStore.getEdges(corpusId);
    for (const edge of edges) {
      yield {
        sourceNodeId: edge.sourceNodeId,
        targetNodeId: edge.targetNodeId,
        weight: edge.weight,
      };
    }
  }

  public async getDanglingNodes(corpusId: string): Promise<readonly string[]> {
    const nodes = await this.graphStore.getNodes(corpusId);
    const edges = await this.graphStore.getEdges(corpusId);
    const withOutgoing = new Set(edges.map((e) => e.sourceNodeId));
    return nodes.filter((n) => !withOutgoing.has(n.nodeId)).map((n) => n.nodeId);
  }

  public async getNodeCount(corpusId: string): Promise<number> {
    const nodes = await this.graphStore.getNodes(corpusId);
    return nodes.length;
  }
}
