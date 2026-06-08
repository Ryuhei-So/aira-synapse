import type Database from 'better-sqlite3';
import type { IGraphStore, IVectorIndex } from '../../domain/storage/index.js';

export interface DeleteDocumentResult {
  readonly corpusId: string;
  readonly documentId: string;
  readonly deletedFacts: number;
  readonly deletedPassages: number;
  readonly deletedSchemas: number;
  readonly deletedGraphNodes: number;
  readonly deletedGraphEdges: number;
  readonly schemaFrequencyAdjusted: number;
}

export class DeleteDocumentService {
  public constructor(
    private readonly db: Database.Database,
    private readonly graphStore: IGraphStore,
    private readonly vectorIndex: IVectorIndex,
  ) {}

  public async deleteDocument(
    corpusId: string,
    documentId: string,
  ): Promise<DeleteDocumentResult> {
    const affectedSchemas = this.db.prepare(
      `SELECT DISTINCT f.schema_id
       FROM facts f
       JOIN fact_documents fd ON fd.fact_id = f.fact_id
       WHERE f.corpus_id = ? AND fd.document_id = ?`,
    ).all(corpusId, documentId) as { schema_id: string }[];

    const deletedPassages = this.db.prepare(
      'DELETE FROM passages WHERE corpus_id = ? AND document_id = ?',
    ).run(corpusId, documentId).changes;

    const deletedFacts = this.db.prepare(
      `DELETE FROM facts
       WHERE corpus_id = ? AND fact_id IN (
         SELECT fact_id FROM fact_documents WHERE document_id = ?
       )`,
    ).run(corpusId, documentId).changes;

    this.db.prepare('DELETE FROM fact_documents WHERE document_id = ?').run(documentId);
    this.db.prepare('DELETE FROM schema_documents WHERE document_id = ?').run(documentId);
    this.db.prepare('DELETE FROM documents WHERE corpus_id = ? AND document_id = ?').run(corpusId, documentId);

    let schemaFrequencyAdjusted = 0;
    for (const row of affectedSchemas) {
      const result = this.db.prepare(
        `UPDATE schemas
         SET frequency = MAX(frequency - 1, 0),
             state = CASE WHEN MAX(frequency - 1, 0) >= stabilization_threshold THEN 'stable' ELSE 'pending' END,
             updated_at = ?
         WHERE corpus_id = ? AND schema_id = ?`,
      ).run(new Date().toISOString(), corpusId, row.schema_id);
      schemaFrequencyAdjusted += result.changes;
    }

    const deletedSchemas = 0;

    const graph = await this.graphStore.deleteByDocument(corpusId, documentId);
    await this.vectorIndex.deleteByDocument(corpusId, documentId);

    return {
      corpusId,
      documentId,
      deletedFacts,
      deletedPassages,
      deletedSchemas,
      deletedGraphNodes: graph.deletedNodes,
      deletedGraphEdges: graph.deletedEdges,
      schemaFrequencyAdjusted,
    };
  }
}
