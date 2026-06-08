/**
 * Infrastructure Layer — SQLite-backed graph store adapter.
 * DES-MG-010, DES-MG-030: Graph persistence for MemGraphRAG.
 */

import type Database from 'better-sqlite3';
import type {
  GraphEdge,
  GraphNode,
  IGraphStore,
} from '../../domain/storage/graphStore.js';
import type { BridgeKind, MemoryLayer } from '../../domain/memory/types.js';

interface GraphNodeRow {
  readonly node_id: string;
  readonly corpus_id: string;
  readonly layer: MemoryLayer;
  readonly ref_id: string;
  readonly label: string;
}

interface GraphEdgeRow {
  readonly edge_id: string;
  readonly corpus_id: string;
  readonly source_node_id: string;
  readonly target_node_id: string;
  readonly relation: GraphEdge['relation'];
  readonly weight: number;
  readonly bridge_kind: BridgeKind | null;
}

function toGraphNode(row: GraphNodeRow): GraphNode {
  return {
    nodeId: row.node_id,
    corpusId: row.corpus_id,
    layer: row.layer,
    ref: JSON.parse(row.ref_id) as GraphNode['ref'],
    label: row.label,
  };
}

function toGraphEdge(row: GraphEdgeRow): GraphEdge {
  return {
    edgeId: row.edge_id,
    corpusId: row.corpus_id,
    sourceNodeId: row.source_node_id,
    targetNodeId: row.target_node_id,
    relation: row.relation,
    weight: row.weight,
    bridgeKind: row.bridge_kind ?? undefined,
  };
}

function makePlaceholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

export class SQLiteGraphStore implements IGraphStore {
  public constructor(private readonly db: Database.Database) {}

  public async upsertNodes(nodes: readonly GraphNode[]): Promise<void> {
    if (nodes.length === 0) {
      return;
    }

    const statement = this.db.prepare(`
      INSERT OR REPLACE INTO graph_nodes (
        node_id, corpus_id, layer, ref_id, label
      ) VALUES (?, ?, ?, ?, ?)
    `);

    const transaction = this.db.transaction((records: readonly GraphNode[]) => {
      for (const node of records) {
        statement.run(
          node.nodeId,
          node.corpusId,
          node.layer,
          JSON.stringify(node.ref),
          node.label,
        );
      }
    });

    transaction(nodes);
  }

  public async upsertEdges(edges: readonly GraphEdge[]): Promise<void> {
    if (edges.length === 0) {
      return;
    }

    const statement = this.db.prepare(`
      INSERT OR REPLACE INTO graph_edges (
        edge_id, corpus_id, source_node_id, target_node_id, relation, weight, bridge_kind
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = this.db.transaction((records: readonly GraphEdge[]) => {
      for (const edge of records) {
        statement.run(
          edge.edgeId,
          edge.corpusId,
          edge.sourceNodeId,
          edge.targetNodeId,
          edge.relation,
          edge.weight,
          edge.bridgeKind ?? null,
        );
      }
    });

    transaction(edges);
  }

  public async getNode(
    corpusId: string,
    nodeId: string,
  ): Promise<GraphNode | null> {
    const row = this.db
      .prepare(
        `SELECT node_id, corpus_id, layer, ref_id, label
         FROM graph_nodes
         WHERE corpus_id = ? AND node_id = ?`,
      )
      .get(corpusId, nodeId) as GraphNodeRow | undefined;

    return row ? toGraphNode(row) : null;
  }

  public async getNodes(
    corpusId: string,
    layer?: MemoryLayer,
  ): Promise<readonly GraphNode[]> {
    const rows = layer
      ? ((this.db
          .prepare(
            `SELECT node_id, corpus_id, layer, ref_id, label
             FROM graph_nodes
             WHERE corpus_id = ? AND layer = ?
             ORDER BY node_id`,
          )
          .all(corpusId, layer) as GraphNodeRow[]))
      : ((this.db
          .prepare(
            `SELECT node_id, corpus_id, layer, ref_id, label
             FROM graph_nodes
             WHERE corpus_id = ?
             ORDER BY node_id`,
          )
          .all(corpusId) as GraphNodeRow[]));

    return rows.map(toGraphNode);
  }

  public async getAdjacent(
    corpusId: string,
    nodeId: string,
  ): Promise<readonly GraphEdge[]> {
    const rows = this.db
      .prepare(
        `SELECT edge_id, corpus_id, source_node_id, target_node_id, relation, weight, bridge_kind
         FROM graph_edges
         WHERE corpus_id = ? AND (source_node_id = ? OR target_node_id = ?)
         ORDER BY edge_id`,
      )
      .all(corpusId, nodeId, nodeId) as GraphEdgeRow[];

    return rows.map(toGraphEdge);
  }

  public async getEdges(
    corpusId: string,
    sourceNodeId?: string,
  ): Promise<readonly GraphEdge[]> {
    const rows = sourceNodeId
      ? ((this.db
          .prepare(
            `SELECT edge_id, corpus_id, source_node_id, target_node_id, relation, weight, bridge_kind
             FROM graph_edges
             WHERE corpus_id = ? AND source_node_id = ?
             ORDER BY edge_id`,
          )
          .all(corpusId, sourceNodeId) as GraphEdgeRow[]))
      : ((this.db
          .prepare(
            `SELECT edge_id, corpus_id, source_node_id, target_node_id, relation, weight, bridge_kind
             FROM graph_edges
             WHERE corpus_id = ?
             ORDER BY edge_id`,
          )
          .all(corpusId) as GraphEdgeRow[]));

    return rows.map(toGraphEdge);
  }

  public async deleteNodes(
    corpusId: string,
    nodeIds: readonly string[],
  ): Promise<number> {
    if (nodeIds.length === 0) {
      return 0;
    }

    const placeholders = makePlaceholders(nodeIds.length);
    const deleteEdges = this.db.prepare(`
      DELETE FROM graph_edges
      WHERE corpus_id = ?
        AND (
          source_node_id IN (${placeholders})
          OR target_node_id IN (${placeholders})
        )
    `);
    const deleteNodes = this.db.prepare(`
      DELETE FROM graph_nodes
      WHERE corpus_id = ? AND node_id IN (${placeholders})
    `);

    const transaction = this.db.transaction((ids: readonly string[]) => {
      deleteEdges.run(corpusId, ...ids, ...ids);
      return deleteNodes.run(corpusId, ...ids).changes;
    });

    return transaction(nodeIds);
  }

  public async deleteEdges(
    corpusId: string,
    edgeIds: readonly string[],
  ): Promise<number> {
    if (edgeIds.length === 0) {
      return 0;
    }

    const placeholders = makePlaceholders(edgeIds.length);
    const result = this.db
      .prepare(
        `DELETE FROM graph_edges
         WHERE corpus_id = ? AND edge_id IN (${placeholders})`,
      )
      .run(corpusId, ...edgeIds);

    return result.changes;
  }

  public async deleteByDocument(
    corpusId: string,
    documentId: string,
  ): Promise<{ deletedNodes: number; deletedEdges: number }> {
    const matchingNodeIds = (
      this.db
        .prepare(
          `SELECT node_id
           FROM graph_nodes
           WHERE corpus_id = ?
             AND (
               json_extract(ref_id, '$.metadata.documentId') = ?
               OR EXISTS (
                 SELECT 1
                 FROM json_each(ref_id, '$.sourceDocumentIds')
                 WHERE value = ?
               )
             )`,
        )
        .all(corpusId, documentId, documentId) as { node_id: string }[]
    ).map((row) => row.node_id);

    if (matchingNodeIds.length === 0) {
      return { deletedNodes: 0, deletedEdges: 0 };
    }

    const placeholders = makePlaceholders(matchingNodeIds.length);
    const deleteEdges = this.db.prepare(`
      DELETE FROM graph_edges
      WHERE corpus_id = ?
        AND (
          source_node_id IN (${placeholders})
          OR target_node_id IN (${placeholders})
        )
    `);
    const deleteNodes = this.db.prepare(`
      DELETE FROM graph_nodes
      WHERE corpus_id = ? AND node_id IN (${placeholders})
    `);

    const transaction = this.db.transaction((nodeIds: readonly string[]) => {
      const edgeResult = deleteEdges.run(corpusId, ...nodeIds, ...nodeIds);
      const nodeResult = deleteNodes.run(corpusId, ...nodeIds);
      return {
        deletedNodes: nodeResult.changes,
        deletedEdges: edgeResult.changes,
      };
    });

    return transaction(matchingNodeIds);
  }

  public async deleteByCorpus(
    corpusId: string,
  ): Promise<{ deletedNodes: number; deletedEdges: number }> {
    const transaction = this.db.transaction((id: string) => {
      const edgeResult = this.db
        .prepare('DELETE FROM graph_edges WHERE corpus_id = ?')
        .run(id);
      const nodeResult = this.db
        .prepare('DELETE FROM graph_nodes WHERE corpus_id = ?')
        .run(id);

      return {
        deletedNodes: nodeResult.changes,
        deletedEdges: edgeResult.changes,
      };
    });

    return transaction(corpusId);
  }
}
