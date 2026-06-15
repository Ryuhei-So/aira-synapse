/**
 * Infrastructure Layer — LadybugDB-backed vector index adapter.
 * DES-LDB-004: IVectorIndex implementation using HNSW.
 */

import type {
  IVectorIndex,
  VectorRecord,
  VectorSearchMatch,
  VectorSearchRequest,
} from '../../../domain/storage/graphStore.js';
import type { ILadybugConnectionPool } from './LadybugConnection.js';

export class LadybugVectorIndex implements IVectorIndex {
  constructor(private readonly pool: ILadybugConnectionPool) {}

  private storageId(corpusId: string, id: string): string {
    return `${corpusId}:${id}`;
  }

  private domainId(storageId: string): string {
    const idx = storageId.indexOf(':');
    return idx >= 0 ? storageId.slice(idx + 1) : storageId;
  }

  async upsert<TMetadata extends Readonly<Record<string, unknown>>>(
    records: readonly VectorRecord<TMetadata>[],
  ): Promise<void> {
    if (records.length === 0) return;
    let needsRebuild = false;
    for (const rec of records) {
      const pk = this.storageId(rec.corpusId, rec.id);
      const documentIds = this.extractDocumentIds(rec.metadata);
      // LadybugDB: cannot SET vec column when HNSW index exists.
      // Must DELETE existing + CREATE new instead of MERGE.
      try {
        const existing = await this.pool.execute(
          `MATCH (v:VectorEntry {pk: $pk}) RETURN v.pk AS pk`,
          { pk },
        );
        const rows = await existing.getAll();
        if (rows.length > 0) {
          await this.pool.execute(
            `MATCH (v:VectorEntry {pk: $pk}) DELETE v`,
            { pk },
          );
          needsRebuild = true;
        }
      } catch { /* node may not exist */ }
      await this.pool.execute(
        `CREATE (v:VectorEntry {
           pk: $pk, corpus_id: $cid, entry_id: $eid, namespace: $ns,
           vec: $vec, meta_json: $meta, document_ids: $dids
         })`,
        {
          pk,
          cid: rec.corpusId,
          eid: rec.id,
          ns: rec.namespace,
          vec: Array.from(rec.values),
          meta: JSON.stringify(rec.metadata),
          dids: JSON.stringify(documentIds),
        },
      );
    }
    // HNSW index must be rebuilt after delete+create to see new entries
    if (needsRebuild) {
      await this.pool.rebuildVectorIndex();
    }
  }

  async search<TMetadata extends Readonly<Record<string, unknown>>>(
    request: VectorSearchRequest,
  ): Promise<readonly VectorSearchMatch<TMetadata>[]> {
    const queryVec = Array.from(request.queryVector);

    // Use HNSW index for approximate nearest neighbor search.
    // Over-fetch to allow post-filtering by corpus_id + namespace.
    const overFetchK = request.topK * 10;
    const result = await this.pool.execute(
      `CALL QUERY_VECTOR_INDEX("VectorEntry", "vec_idx", $vec, $k)
       RETURN node.pk AS pk, node.corpus_id AS cid, node.entry_id AS eid,
              node.namespace AS ns, node.meta_json AS meta, distance`,
      { vec: queryVec, k: overFetchK },
    );
    const rows = await result.getAll();

    const matches: VectorSearchMatch<TMetadata>[] = [];
    for (const r of rows) {
      if (r.cid !== request.corpusId) continue;
      if (r.ns !== request.namespace) continue;

      // LadybugDB HNSW returns cosine distance: 0 = identical, 1 = orthogonal.
      // Convert to cosine similarity: score = 1 - distance
      const dist = r.distance as number;
      const score = 1 - dist;

      if (request.threshold !== undefined && score < request.threshold) continue;

      matches.push({
        id: r.eid as string,
        score,
        metadata: JSON.parse(r.meta as string) as TMetadata,
      });

      if (matches.length >= request.topK) break;
    }

    return matches;
  }

  async deleteByDocument(corpusId: string, documentId: string): Promise<void> {
    const findResult = await this.pool.execute(
      `MATCH (v:VectorEntry)
       WHERE v.corpus_id = $cid AND v.document_ids CONTAINS $docId
       RETURN v.pk AS pk`,
      { cid: corpusId, docId: `"${documentId}"` },
    );
    const pks = (await findResult.getAll()).map((r) => r.pk as string);
    for (const pk of pks) {
      await this.pool.execute(
        `MATCH (v:VectorEntry {pk: $pk}) DELETE v`,
        { pk },
      );
    }
    if (pks.length > 0) {
      await this.pool.rebuildVectorIndex();
    }
  }

  private extractDocumentIds(metadata: Readonly<Record<string, unknown>>): string[] {
    if (typeof metadata.documentId === 'string') return [metadata.documentId];
    if (Array.isArray(metadata.sourceDocumentIds)) return metadata.sourceDocumentIds as string[];
    return [];
  }
}
