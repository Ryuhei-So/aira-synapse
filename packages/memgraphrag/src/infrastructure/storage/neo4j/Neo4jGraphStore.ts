/**
 * Infrastructure Layer — Neo4j-backed graph store adapter.
 * IGraphStore implementation using Cypher.
 */

import type {
  GraphEdge,
  GraphNode,
  IGraphStore,
} from '../../../domain/storage/graphStore.js';
import type { MemoryLayer } from '../../../domain/memory/types.js';
import { isBridgeKind } from '../../../domain/memory/types.js';
import type { INeo4jConnectionPool } from './Neo4jConnection.js';

export class Neo4jGraphStore implements IGraphStore {
  /** Exposed for VectorMemoryFilter and GraphProjection. */
  readonly _pool: INeo4jConnectionPool;

  constructor(pool: INeo4jConnectionPool) {
    this._pool = pool;
  }

  private storageId(corpusId: string, nodeId: string): string {
    return `${corpusId}:${nodeId}`;
  }

  // --- Writes ---

  async upsertNodes(nodes: readonly GraphNode[]): Promise<void> {
    if (nodes.length === 0) return;

    // Batch via UNWIND for performance
    const rows = nodes.map((node) => ({
      pk: this.storageId(node.corpusId, node.nodeId),
      cid: node.corpusId,
      nid: node.nodeId,
      layer: node.layer,
      label: node.label,
      ref: JSON.stringify(node.ref),
      dids: JSON.stringify(this.extractDocumentIds(node.ref)),
    }));

    await this._pool.execute(
      `UNWIND $rows AS row
       MERGE (n:GNode {pk: row.pk})
       SET n.corpus_id = row.cid, n.node_id = row.nid, n.layer = row.layer,
           n.label = row.label, n.ref_json = row.ref, n.document_ids = row.dids`,
      { rows },
    );
    this._pool.emitGraphMutation(nodes[0]!.corpusId);
  }

  async upsertEdges(edges: readonly GraphEdge[]): Promise<void> {
    if (edges.length === 0) return;

    const rows = edges.map((edge) => ({
      src: this.storageId(edge.corpusId, edge.sourceNodeId),
      tgt: this.storageId(edge.corpusId, edge.targetNodeId),
      eid: edge.edgeId,
      cid: edge.corpusId,
      rel: edge.relation,
      w: edge.weight,
      bk: edge.bridgeKind ?? '',
      dids: JSON.stringify([]),
    }));

    await this._pool.withSession(async (session) => {
      const tx = session.beginTransaction();
      try {
        await tx.run(
          `UNWIND $rows AS row
           MATCH (a:GNode {pk: row.src}), (b:GNode {pk: row.tgt})
           CREATE (a)-[:GEdge {
             edge_id: row.eid, corpus_id: row.cid, relation: row.rel,
             weight: row.w, bridge_kind: row.bk, document_ids: row.dids
           }]->(b)`,
          { rows },
        );
        await tx.commit();
      } catch (err) {
        await tx.rollback();
        throw err;
      }
    });
    this._pool.emitGraphMutation(edges[0]!.corpusId);
  }

  // --- Reads ---

  async getNode(corpusId: string, nodeId: string): Promise<GraphNode | null> {
    const pk = this.storageId(corpusId, nodeId);
    const result = await this._pool.execute(
      `MATCH (n:GNode {pk: $pk})
       RETURN n.node_id AS nid, n.corpus_id AS cid, n.layer AS layer,
              n.label AS label, n.ref_json AS ref_json`,
      { pk },
    );
    if (result.records.length === 0) return null;
    const r = result.records[0]!;
    return {
      nodeId: r.get('nid') as string,
      corpusId: r.get('cid') as string,
      layer: r.get('layer') as MemoryLayer,
      label: r.get('label') as string,
      ref: JSON.parse(r.get('ref_json') as string),
    };
  }

  async getNodes(
    corpusId: string,
    layer?: MemoryLayer,
  ): Promise<readonly GraphNode[]> {
    const cypher = layer
      ? `MATCH (n:GNode) WHERE n.corpus_id = $cid AND n.layer = $layer
         RETURN n.node_id AS nid, n.corpus_id AS cid, n.layer AS layer,
                n.label AS label, n.ref_json AS ref_json
         ORDER BY n.node_id`
      : `MATCH (n:GNode) WHERE n.corpus_id = $cid
         RETURN n.node_id AS nid, n.corpus_id AS cid, n.layer AS layer,
                n.label AS label, n.ref_json AS ref_json
         ORDER BY n.node_id`;
    const params: Record<string, unknown> = { cid: corpusId };
    if (layer) params.layer = layer;
    const result = await this._pool.execute(cypher, params);
    return result.records.map((r) => ({
      nodeId: r.get('nid') as string,
      corpusId: r.get('cid') as string,
      layer: r.get('layer') as MemoryLayer,
      label: r.get('label') as string,
      ref: JSON.parse(r.get('ref_json') as string),
    }));
  }

  async getAdjacent(
    corpusId: string,
    nodeId: string,
  ): Promise<readonly GraphEdge[]> {
    const pk = this.storageId(corpusId, nodeId);
    // Both outgoing and incoming edges
    const result = await this._pool.execute(
      `MATCH (a:GNode {pk: $pk})-[e:GEdge]-(b:GNode)
       WHERE e.corpus_id = $cid
       RETURN e.edge_id AS eid, e.corpus_id AS cid,
              e.relation AS rel, e.weight AS w, e.bridge_kind AS bk,
              startNode(e).node_id AS src_nid, endNode(e).node_id AS tgt_nid`,
      { pk, cid: corpusId },
    );
    const edges = result.records.map((r) => this.recordToEdge(r));
    return this.deduplicateEdges(edges);
  }

  async getEdges(
    corpusId: string,
    sourceNodeId?: string,
  ): Promise<readonly GraphEdge[]> {
    if (sourceNodeId) {
      const srcPk = this.storageId(corpusId, sourceNodeId);
      const result = await this._pool.execute(
        `MATCH (a:GNode {pk: $src})-[e:GEdge]->(b:GNode)
         WHERE e.corpus_id = $cid
         RETURN e.edge_id AS eid, e.corpus_id AS cid,
                e.relation AS rel, e.weight AS w, e.bridge_kind AS bk,
                a.node_id AS src_nid, b.node_id AS tgt_nid
         ORDER BY e.edge_id`,
        { src: srcPk, cid: corpusId },
      );
      return result.records.map((r) => this.recordToEdge(r));
    }
    const result = await this._pool.execute(
      `MATCH (a:GNode)-[e:GEdge]->(b:GNode)
       WHERE e.corpus_id = $cid
       RETURN e.edge_id AS eid, e.corpus_id AS cid,
              e.relation AS rel, e.weight AS w, e.bridge_kind AS bk,
              a.node_id AS src_nid, b.node_id AS tgt_nid
       ORDER BY e.edge_id`,
      { cid: corpusId },
    );
    return result.records.map((r) => this.recordToEdge(r));
  }

  // --- Deletes ---

  async deleteNodes(
    corpusId: string,
    nodeIds: readonly string[],
  ): Promise<number> {
    if (nodeIds.length === 0) return 0;
    const pks = nodeIds.map((nid) => this.storageId(corpusId, nid));
    const result = await this._pool.execute(
      `MATCH (n:GNode) WHERE n.pk IN $pks
       DETACH DELETE n
       RETURN count(n) AS c`,
      { pks },
    );
    const count = result.records[0]?.get('c')?.toNumber?.() ?? 0;
    if (count > 0) this._pool.emitGraphMutation(corpusId);
    return count;
  }

  async deleteEdges(
    corpusId: string,
    edgeIds: readonly string[],
  ): Promise<number> {
    if (edgeIds.length === 0) return 0;
    const result = await this._pool.execute(
      `MATCH ()-[e:GEdge]->()
       WHERE e.corpus_id = $cid AND e.edge_id IN $eids
       DELETE e
       RETURN count(e) AS c`,
      { cid: corpusId, eids: edgeIds },
    );
    const count = result.records[0]?.get('c')?.toNumber?.() ?? 0;
    if (count > 0) this._pool.emitGraphMutation(corpusId);
    return count;
  }

  async deleteByDocument(
    corpusId: string,
    documentId: string,
  ): Promise<{ deletedNodes: number; deletedEdges: number }> {
    // Count edges first
    const edgeResult = await this._pool.execute(
      `MATCH (n:GNode)-[e:GEdge]-()
       WHERE n.corpus_id = $cid
         AND (n.document_ids CONTAINS $docPattern)
       RETURN count(DISTINCT e) AS c`,
      { cid: corpusId, docPattern: `"${documentId}"` },
    );
    const deletedEdges = edgeResult.records[0]?.get('c')?.toNumber?.() ?? 0;

    // Delete nodes (DETACH removes edges too)
    const nodeResult = await this._pool.execute(
      `MATCH (n:GNode)
       WHERE n.corpus_id = $cid
         AND (n.document_ids CONTAINS $docPattern)
       DETACH DELETE n
       RETURN count(n) AS c`,
      { cid: corpusId, docPattern: `"${documentId}"` },
    );
    const deletedNodes = nodeResult.records[0]?.get('c')?.toNumber?.() ?? 0;

    if (deletedNodes > 0) this._pool.emitGraphMutation(corpusId);
    return { deletedNodes, deletedEdges };
  }

  async deleteByCorpus(
    corpusId: string,
  ): Promise<{ deletedNodes: number; deletedEdges: number }> {
    const edgeCount = await this._pool.execute(
      `MATCH ()-[e:GEdge]->() WHERE e.corpus_id = $cid RETURN count(e) AS c`,
      { cid: corpusId },
    );
    const nodeCount = await this._pool.execute(
      `MATCH (n:GNode) WHERE n.corpus_id = $cid RETURN count(n) AS c`,
      { cid: corpusId },
    );

    await this._pool.execute(
      `MATCH (n:GNode) WHERE n.corpus_id = $cid DETACH DELETE n`,
      { cid: corpusId },
    );

    this._pool.emitGraphMutation(corpusId);
    return {
      deletedNodes: nodeCount.records[0]?.get('c')?.toNumber?.() ?? 0,
      deletedEdges: edgeCount.records[0]?.get('c')?.toNumber?.() ?? 0,
    };
  }

  // --- Helpers ---

  private recordToEdge(r: { get(key: string): unknown }): GraphEdge {
    const bk = r.get('bk') as string | undefined;
    const w = r.get('w');
    return {
      edgeId: r.get('eid') as string,
      corpusId: r.get('cid') as string,
      sourceNodeId: r.get('src_nid') as string,
      targetNodeId: r.get('tgt_nid') as string,
      relation: r.get('rel') as GraphEdge['relation'],
      weight: typeof w === 'object' && w !== null && 'toNumber' in w
        ? (w as { toNumber(): number }).toNumber()
        : w as number,
      bridgeKind: bk && isBridgeKind(bk) ? bk : undefined,
    };
  }

  private deduplicateEdges(edges: GraphEdge[]): GraphEdge[] {
    const seen = new Set<string>();
    return edges.filter((e) => {
      if (seen.has(e.edgeId)) return false;
      seen.add(e.edgeId);
      return true;
    });
  }

  private extractDocumentIds(ref: unknown): string[] {
    if (ref && typeof ref === 'object') {
      const r = ref as Record<string, unknown>;
      if (Array.isArray(r.sourceDocumentIds)) return r.sourceDocumentIds as string[];
      if (r.metadata && typeof r.metadata === 'object') {
        const meta = r.metadata as Record<string, unknown>;
        if (typeof meta.documentId === 'string') return [meta.documentId];
      }
    }
    return [];
  }
}
