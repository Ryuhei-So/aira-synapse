/**
 * Per-document replace delete (literature-hub #614, design #612 §5.1).
 *
 * The native `memory_delete_document` removes one document's passages, facts,
 * graph nodes and vectors inside the caller's open batch while keeping shared
 * schema/ontology state: schemas lose the document from their support (with
 * `DeleteDocumentService` frequency semantics), and ontology vectors that name
 * the document are re-keyed to a remaining source.  Reads inside the active
 * batch see the post-delete state; nothing is visible until `batch_commit`.
 */
export interface MemoryDeleteDocumentRequest {
  readonly corpusId: string;
  readonly documentId: string;
  /** Caller clock; stamped only on refs that already carry `updatedAt`. */
  readonly updatedAt: string;
}

/** The native's flat count result, field for field. */
export interface MemoryDeleteDocumentResult {
  readonly corpusId: string;
  readonly documentId: string;
  readonly noop: boolean;
  readonly removedPassages: number;
  readonly removedFacts: number;
  readonly prunedSharedFacts: number;
  readonly prunedSchemas: number;
  readonly schemaFrequencyAdjusted: number;
  readonly removedPassageNodes: number;
  readonly removedFactNodes: number;
  readonly removedEntityNodes: number;
  readonly removedOtherNodes: number;
  readonly prunedSharedNodes: number;
  readonly prunedOntologyNodes: number;
  readonly removedOntologyNodes: number;
  readonly removedEdges: number;
  readonly removedVectors: number;
  readonly rekeyedVectors: number;
  readonly removedLexicalPassages: number;
}

export const MEMORY_DELETE_DOCUMENT_COUNT_KEYS = [
  'removedPassages',
  'removedFacts',
  'prunedSharedFacts',
  'prunedSchemas',
  'schemaFrequencyAdjusted',
  'removedPassageNodes',
  'removedFactNodes',
  'removedEntityNodes',
  'removedOtherNodes',
  'prunedSharedNodes',
  'prunedOntologyNodes',
  'removedOntologyNodes',
  'removedEdges',
  'removedVectors',
  'rekeyedVectors',
  'removedLexicalPassages',
] as const satisfies readonly (keyof MemoryDeleteDocumentResult)[];

export interface IDocumentReplaceMemory {
  memoryDeleteDocument(request: MemoryDeleteDocumentRequest): Promise<MemoryDeleteDocumentResult>;
}
