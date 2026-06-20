/**
 * Infrastructure Layer — Neo4j-backed vector index adapter.
 * IVectorIndex implementation using Neo4j vector index (5.11+).
 */

import type {
  IVectorIndex,
  VectorRecord,
  VectorSearchMatch,
  VectorSearchRequest,
} from '../../../domain/storage/graphStore.js';
import type { INeo4jConnectionPool } from './Neo4jConnection.js';

export class Neo4jVectorIndex implements IVectorIndex {
  constructor(private readonly pool: INeo4jConnectionPool) {}

  private storageId(corpusId: string, id: string): string {
    return `${corpusId}:${id}`;
  }

  async upsert<TMetadata extends Readonly<Record<string, unknown>>>(
    records: readonly VectorRecord<TMetadata>[],
  ): Promise<void> {
    if (records.length === 0) return;

    // Neo4j supports SET on vector properties — no delete+create needed
    const rows = records.map((rec) => ({
      pk: this.storageId(rec.corpusId, rec.id),
      cid: rec.corpusId,
      eid: rec.id,
      ns: rec.namespace,
      vec: Array.from(rec.values),
      meta: JSON.stringify(rec.metadata),
      dids: JSON.stringify(this.extractDocumentIds(rec.metadata)),
    }));

    // Batch via UNWIND
    await this.pool.execute(
      `UNWIND $rows AS row
       MERGE (v:VectorEntry {pk: row.pk})
       SET v.corpus_id = row.cid, v.entry_id = row.eid, v.namespace = row.ns,
           v.vec = row.vec, v.meta_json = row.meta, v.document_ids = row.dids`,
      { rows },
    );
  }

  async search<TMetadata extends Readonly<Record<string, unknown>>>(
    request: VectorSearchRequest,
  ): Promise<readonly VectorSearchMatch<TMetadata>[]> {
    const queryVec = Array.from(request.queryVector);

    // Over-fetch to allow post-filtering by corpus_id + namespace
    const overFetchK = request.topK * 10;

    const result = await this.pool.execute(
      `CALL db.index.vector.queryNodes('vector_idx', $k, $vec)
       YIELD node, score
       RETURN node.pk AS pk, node.corpus_id AS cid, node.entry_id AS eid,
              node.namespace AS ns, node.meta_json AS meta, score`,
      { vec: queryVec, k: overFetchK },
    );

    const matches: VectorSearchMatch<TMetadata>[] = [];
    for (const r of result.records) {
      if (r.get('cid') !== request.corpusId) continue;
      if (r.get('ns') !== request.namespace) continue;

      // Neo4j vector index returns cosine similarity directly (0-1)
      const score = typeof r.get('score') === 'object'
        ? (r.get('score') as { toNumber(): number }).toNumber()
        : r.get('score') as number;

      if (request.threshold !== undefined && score < request.threshold) continue;

      matches.push({
        id: r.get('eid') as string,
        score,
        metadata: JSON.parse(r.get('meta') as string) as TMetadata,
      });

      if (matches.length >= request.topK) break;
    }

    return matches;
  }

  async deleteByDocument(corpusId: string, documentId: string): Promise<void> {
    await this.pool.execute(
      `MATCH (v:VectorEntry)
       WHERE v.corpus_id = $cid AND v.document_ids CONTAINS $docId
       DELETE v`,
      { cid: corpusId, docId: `"${documentId}"` },
    );
  }

  private extractDocumentIds(metadata: Readonly<Record<string, unknown>>): string[] {
    if (typeof metadata.documentId === 'string') return [metadata.documentId];
    if (Array.isArray(metadata.sourceDocumentIds)) return metadata.sourceDocumentIds as string[];
    return [];
  }
}
