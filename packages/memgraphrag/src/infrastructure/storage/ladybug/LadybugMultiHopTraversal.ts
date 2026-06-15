/**
 * Infrastructure Layer — LadybugDB multi-hop graph traversal.
 * DES-LDB-010: Cypher variable-length path traversal for context expansion.
 */

import type { MemoryLayer } from '../../../domain/memory/types.js';
import type { ILadybugConnectionPool } from './LadybugConnection.js';

export interface MultiHopResult {
  readonly nodeId: string;
  readonly layer: MemoryLayer;
  readonly label: string;
  readonly hops: number;
  readonly pathWeight: number;
}

export interface MultiHopOptions {
  readonly maxHops?: number;
  readonly relationFilter?: readonly string[];
  readonly minWeight?: number;
  readonly topK?: number;
}

export class LadybugMultiHopTraversal {
  constructor(private readonly pool: ILadybugConnectionPool) {}

  private storageId(corpusId: string, nodeId: string): string {
    return `${corpusId}:${nodeId}`;
  }

  /**
   * Traverse the graph from seed nodes up to maxHops, returning discovered nodes
   * ranked by cumulative path weight. Entity-layer nodes are excluded.
   */
  async traverse(
    corpusId: string,
    seedNodeIds: readonly string[],
    opts: MultiHopOptions = {},
  ): Promise<readonly MultiHopResult[]> {
    const maxHops = opts.maxHops ?? 3;
    const topK = opts.topK ?? 50;

    if (seedNodeIds.length === 0) return [];

    // LadybugDB doesn't support variable-length path with complex filters well.
    // Use iterative BFS approach: for each hop, fetch neighbors.
    const visited = new Set<string>();
    const results: MultiHopResult[] = [];

    // Current frontier: { pk, nodeId, layer, label, hops, pathWeight }
    interface FrontierEntry {
      pk: string;
      nodeId: string;
      layer: MemoryLayer;
      label: string;
      hops: number;
      pathWeight: number;
    }

    // Initialize with seed nodes
    let frontier: FrontierEntry[] = [];
    for (const nodeId of seedNodeIds) {
      const pk = this.storageId(corpusId, nodeId);
      const nodeResult = await this.pool.execute(
        `MATCH (n:GNode {pk: $pk}) RETURN n.node_id AS nid, n.layer AS layer, n.label AS label`,
        { pk },
      );
      const rows = await nodeResult.getAll();
      if (rows.length > 0) {
        const r = rows[0]!;
        visited.add(pk);
        frontier.push({
          pk,
          nodeId: r.nid as string,
          layer: r.layer as MemoryLayer,
          label: r.label as string,
          hops: 0,
          pathWeight: 1.0,
        });
      }
    }

    for (let hop = 1; hop <= maxHops; hop++) {
      const nextFrontier: FrontierEntry[] = [];

      for (const entry of frontier) {
        // Get outgoing edges
        const outResult = await this.pool.execute(
          `MATCH (a:GNode {pk: $pk})-[e:GEdge]->(b:GNode)
           WHERE e.corpus_id = $cid
           RETURN b.pk AS bpk, b.node_id AS nid, b.layer AS layer,
                  b.label AS label, e.relation AS rel, e.weight AS w`,
          { pk: entry.pk, cid: corpusId },
        );
        const outRows = await outResult.getAll();

        // Get incoming edges
        const inResult = await this.pool.execute(
          `MATCH (a:GNode)-[e:GEdge]->(b:GNode {pk: $pk})
           WHERE e.corpus_id = $cid
           RETURN a.pk AS bpk, a.node_id AS nid, a.layer AS layer,
                  a.label AS label, e.relation AS rel, e.weight AS w`,
          { pk: entry.pk, cid: corpusId },
        );
        const inRows = await inResult.getAll();

        for (const r of [...outRows, ...inRows]) {
          const neighborPk = r.bpk as string;
          if (visited.has(neighborPk)) continue;

          const layer = r.layer as MemoryLayer;
          if (layer === 'entity') continue; // exclude entity layer

          const relation = r.rel as string;
          if (opts.relationFilter && !opts.relationFilter.includes(relation)) continue;

          const weight = r.w as number;
          if (opts.minWeight !== undefined && weight < opts.minWeight) continue;

          const pathWeight = entry.pathWeight * weight;

          visited.add(neighborPk);
          const neighbor: FrontierEntry = {
            pk: neighborPk,
            nodeId: r.nid as string,
            layer,
            label: r.label as string,
            hops: hop,
            pathWeight,
          };
          nextFrontier.push(neighbor);
          results.push({
            nodeId: neighbor.nodeId,
            layer: neighbor.layer,
            label: neighbor.label,
            hops: hop,
            pathWeight,
          });
        }
      }

      frontier = nextFrontier;
      if (frontier.length === 0) break;
    }

    // Sort by pathWeight descending and take topK
    results.sort((a, b) => b.pathWeight - a.pathWeight);
    return results.slice(0, topK);
  }
}
