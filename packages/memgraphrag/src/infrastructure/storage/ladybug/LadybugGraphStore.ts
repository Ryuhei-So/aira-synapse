/**
 * Infrastructure Layer — LadybugDB-backed graph store adapter.
 * DES-LDB-003: IGraphStore implementation using Cypher.
 */

import type {
  GraphEdge,
  GraphNode,
  IGraphStore,
} from '../../../domain/storage/graphStore.js';
import type { MemoryLayer } from '../../../domain/memory/types.js';
import type { ILadybugConnectionPool } from './LadybugConnection.js';

export class LadybugGraphStore implements IGraphStore {
  constructor(private readonly pool: ILadybugConnectionPool) {}

  // --- ID Mapping ---
  private storageId(corpusId: string, nodeId: string): string {
    return `${corpusId}:${nodeId}`;
  }

  private domainId(storageId: string): string {
    const idx = storageId.indexOf(':');
    return idx >= 0 ? storageId.slice(idx + 1) : storageId;
  }

  private domainCorpusId(storageId: string): string {
    const idx = storageId.indexOf(':');
    return idx >= 0 ? storageId.slice(0, idx) : '';
  }

  // --- Writes ---

  async upsertNodes(nodes: readonly GraphNode[]): Promise<void> {
    if (nodes.length === 0) return;
    for (const node of nodes) {
      const pk = this.storageId(node.corpusId, node.nodeId);
      const documentIds = this.extractDocumentIds(node.ref);
      await this.pool.execute(
        `MERGE (n:GNode {pk: $pk})
         SET n.corpus_id = $cid, n.node_id = $nid, n.layer = $layer,
             n.label = $label, n.ref_json = $ref, n.document_ids = $dids`,
        {
          pk,
          cid: node.corpusId,
          nid: node.nodeId,
          layer: node.layer,
          label: node.label,
          ref: JSON.stringify(node.ref),
          dids: JSON.stringify(documentIds),
        },
      );
    }
    if (nodes.length > 0) {
      this.pool.emitGraphMutation(nodes[0]!.corpusId);
    }
  }

  async upsertEdges(edges: readonly GraphEdge[]): Promise<void> {
    if (edges.length === 0) return;
    // Atomic: all edges in a single transaction
    await this.pool.withConnection(async (conn) => {
      await conn.query('BEGIN TRANSACTION');
      try {
        for (const edge of edges) {
          const srcPk = this.storageId(edge.corpusId, edge.sourceNodeId);
          const tgtPk = this.storageId(edge.corpusId, edge.targetNodeId);
          const documentIds = JSON.stringify([]);
          const ps = await conn.prepare(
            `MATCH (a:GNode {pk: $src}), (b:GNode {pk: $tgt})
             CREATE (a)-[:GEdge {
               edge_id: $eid, corpus_id: $cid, relation: $rel,
               weight: $w, bridge_kind: $bk, document_ids: $dids
             }]->(b)`,
          );
          await conn.execute(ps, {
            src: srcPk,
            tgt: tgtPk,
            eid: edge.edgeId,
            cid: edge.corpusId,
            rel: edge.relation,
            w: edge.weight,
            bk: edge.bridgeKind ?? '',
            dids: documentIds,
          });
        }
        await conn.query('COMMIT');
      } catch (err) {
        await conn.query('ROLLBACK');
        throw err;
      }
    });
    this.pool.emitGraphMutation(edges[0]!.corpusId);
  }

  // --- Reads ---

  async getNode(corpusId: string, nodeId: string): Promise<GraphNode | null> {
    const pk = this.storageId(corpusId, nodeId);
    const result = await this.pool.execute(
      `MATCH (n:GNode {pk: $pk})
       RETURN n.node_id AS nid, n.corpus_id AS cid, n.layer AS layer,
              n.label AS label, n.ref_json AS ref_json`,
      { pk },
    );
    const rows = await result.getAll();
    if (rows.length === 0) return null;
    const r = rows[0]!;
    return {
      nodeId: r.nid as string,
      corpusId: r.cid as string,
      layer: r.layer as MemoryLayer,
      label: r.label as string,
      ref: JSON.parse(r.ref_json as string),
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
    const result = await this.pool.execute(cypher, params);
    const rows = await result.getAll();
    return rows.map((r) => ({
      nodeId: r.nid as string,
      corpusId: r.cid as string,
      layer: r.layer as MemoryLayer,
      label: r.label as string,
      ref: JSON.parse(r.ref_json as string),
    }));
  }

  async getAdjacent(
    corpusId: string,
    nodeId: string,
  ): Promise<readonly GraphEdge[]> {
    const pk = this.storageId(corpusId, nodeId);
    // Match outgoing edges from this node
    const outResult = await this.pool.execute(
      `MATCH (a:GNode {pk: $pk})-[e:GEdge]->(b:GNode)
       WHERE e.corpus_id = $cid
       RETURN e.edge_id AS eid, e.corpus_id AS cid,
              e.relation AS rel, e.weight AS w, e.bridge_kind AS bk,
              a.node_id AS src_nid, b.node_id AS tgt_nid`,
      { pk, cid: corpusId },
    );
    // Match incoming edges to this node
    const inResult = await this.pool.execute(
      `MATCH (a:GNode)-[e:GEdge]->(b:GNode {pk: $pk})
       WHERE e.corpus_id = $cid
       RETURN e.edge_id AS eid, e.corpus_id AS cid,
              e.relation AS rel, e.weight AS w, e.bridge_kind AS bk,
              a.node_id AS src_nid, b.node_id AS tgt_nid`,
      { pk, cid: corpusId },
    );
    const outRows = await outResult.getAll();
    const inRows = await inResult.getAll();
    const allRows = [...outRows, ...inRows];
    const edges = allRows.map((r) => this.rowToEdgeByNodeId(r));
    return this.deduplicateEdges(edges);
  }

  async getEdges(
    corpusId: string,
    sourceNodeId?: string,
  ): Promise<readonly GraphEdge[]> {
    if (sourceNodeId) {
      const srcPk = this.storageId(corpusId, sourceNodeId);
      const result = await this.pool.execute(
        `MATCH (a:GNode {pk: $src})-[e:GEdge]->(b:GNode)
         WHERE e.corpus_id = $cid
         RETURN e.edge_id AS eid, e.corpus_id AS cid,
                e.relation AS rel, e.weight AS w, e.bridge_kind AS bk,
                a.node_id AS src_nid, b.node_id AS tgt_nid
         ORDER BY e.edge_id`,
        { src: srcPk, cid: corpusId },
      );
      const rows = await result.getAll();
      return rows.map((r) => this.rowToEdgeByNodeId(r));
    }
    const result = await this.pool.execute(
      `MATCH (a:GNode)-[e:GEdge]->(b:GNode)
       WHERE e.corpus_id = $cid
       RETURN e.edge_id AS eid, e.corpus_id AS cid,
              e.relation AS rel, e.weight AS w, e.bridge_kind AS bk,
              a.node_id AS src_nid, b.node_id AS tgt_nid
       ORDER BY e.edge_id`,
      { cid: corpusId },
    );
    const rows = await result.getAll();
    return rows.map((r) => this.rowToEdgeByNodeId(r));
  }

  // --- Deletes ---

  async deleteNodes(
    corpusId: string,
    nodeIds: readonly string[],
  ): Promise<number> {
    if (nodeIds.length === 0) return 0;
    let count = 0;
    for (const nodeId of nodeIds) {
      const pk = this.storageId(corpusId, nodeId);
      // Delete node and all its edges (DETACH DELETE)
      const result = await this.pool.execute(
        `MATCH (n:GNode {pk: $pk}) DETACH DELETE n RETURN count(n) AS c`,
        { pk },
      );
      const rows = await result.getAll();
      count += (rows[0]?.c as number) ?? 0;
    }
    if (count > 0) this.pool.emitGraphMutation(corpusId);
    return count;
  }

  async deleteEdges(
    corpusId: string,
    edgeIds: readonly string[],
  ): Promise<number> {
    if (edgeIds.length === 0) return 0;
    let count = 0;
    for (const edgeId of edgeIds) {
      const result = await this.pool.execute(
        `MATCH ()-[e:GEdge {edge_id: $eid, corpus_id: $cid}]->()
         DELETE e RETURN count(e) AS c`,
        { eid: edgeId, cid: corpusId },
      );
      const rows = await result.getAll();
      count += (rows[0]?.c as number) ?? 0;
    }
    if (count > 0) this.pool.emitGraphMutation(corpusId);
    return count;
  }

  async deleteByDocument(
    corpusId: string,
    documentId: string,
  ): Promise<{ deletedNodes: number; deletedEdges: number }> {
    // Find nodes that reference this document
    const findResult = await this.pool.execute(
      `MATCH (n:GNode)
       WHERE n.corpus_id = $cid AND (
         n.ref_json CONTAINS $docPattern1
         OR n.ref_json CONTAINS $docPattern2
       )
       RETURN n.pk AS pk`,
      {
        cid: corpusId,
        docPattern1: `"documentId":"${documentId}"`,
        docPattern2: `"${documentId}"`,
      },
    );
    const matchingPks = (await findResult.getAll()).map((r) => r.pk as string);

    if (matchingPks.length === 0) {
      return { deletedNodes: 0, deletedEdges: 0 };
    }

    // Count edges incident to these nodes
    let deletedEdges = 0;
    for (const pk of matchingPks) {
      const edgeCount = await this.pool.execute(
        `MATCH (n:GNode {pk: $pk})-[e:GEdge]-()
         RETURN count(e) AS c`,
        { pk },
      );
      const rows = await edgeCount.getAll();
      deletedEdges += (rows[0]?.c as number) ?? 0;
    }
    // Edges are counted from both endpoints; divide by 2 for internal edges
    // But actually, DETACH DELETE handles it. Count before delete.
    
    // Get precise edge count by collecting unique edge IDs
    const edgeIds = new Set<string>();
    for (const pk of matchingPks) {
      const edgeResult = await this.pool.execute(
        `MATCH (n:GNode {pk: $pk})-[e:GEdge]-()
         RETURN e.edge_id AS eid`,
        { pk },
      );
      for (const r of await edgeResult.getAll()) {
        edgeIds.add(r.eid as string);
      }
    }

    // DETACH DELETE all matching nodes
    let deletedNodes = 0;
    for (const pk of matchingPks) {
      const result = await this.pool.execute(
        `MATCH (n:GNode {pk: $pk}) DETACH DELETE n RETURN count(n) AS c`,
        { pk },
      );
      const rows = await result.getAll();
      deletedNodes += (rows[0]?.c as number) ?? 0;
    }

    this.pool.emitGraphMutation(corpusId);
    return { deletedNodes, deletedEdges: edgeIds.size };
  }

  async deleteByCorpus(
    corpusId: string,
  ): Promise<{ deletedNodes: number; deletedEdges: number }> {
    // Count first
    const nodeCount = await this.pool.execute(
      `MATCH (n:GNode) WHERE n.corpus_id = $cid RETURN count(n) AS c`,
      { cid: corpusId },
    );
    const edgeCount = await this.pool.execute(
      `MATCH ()-[e:GEdge]->() WHERE e.corpus_id = $cid RETURN count(e) AS c`,
      { cid: corpusId },
    );
    const nRows = await nodeCount.getAll();
    const eRows = await edgeCount.getAll();

    // Delete edges first, then nodes
    await this.pool.execute(
      `MATCH ()-[e:GEdge]->() WHERE e.corpus_id = $cid DELETE e`,
      { cid: corpusId },
    );
    await this.pool.execute(
      `MATCH (n:GNode) WHERE n.corpus_id = $cid DELETE n`,
      { cid: corpusId },
    );

    this.pool.emitGraphMutation(corpusId);
    return {
      deletedNodes: (nRows[0]?.c as number) ?? 0,
      deletedEdges: (eRows[0]?.c as number) ?? 0,
    };
  }

  // --- Helpers ---

  private rowToEdge(r: Record<string, unknown>): GraphEdge {
    return {
      edgeId: r.eid as string,
      corpusId: r.cid as string,
      sourceNodeId: this.domainId(r.src_pk as string),
      targetNodeId: this.domainId(r.tgt_pk as string),
      relation: r.rel as GraphEdge['relation'],
      weight: r.w as number,
      bridgeKind: (r.bk as string) || undefined,
    };
  }

  private rowToEdgeByNodeId(r: Record<string, unknown>): GraphEdge {
    return {
      edgeId: r.eid as string,
      corpusId: r.cid as string,
      sourceNodeId: r.src_nid as string,
      targetNodeId: r.tgt_nid as string,
      relation: r.rel as GraphEdge['relation'],
      weight: r.w as number,
      bridgeKind: (r.bk as string) || undefined,
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
