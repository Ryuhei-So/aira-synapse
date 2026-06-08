/**
 * Domain Layer — Extraction Agent and Schema Canonicalizer ports.
 * DES-MG-003: Composite Extraction and Schema Canonicalization.
 */

import type { LanguageCode } from '../memory/types.js';
import type { DocumentMetadata, Passage } from '../memory/passage.js';
import type { SchemaAlias, SchemaCandidate } from '../memory/schema.js';
import type { FactCandidate } from '../memory/fact.js';

export interface ExtractionChunk {
  readonly corpusId: string;
  readonly documentId: string;
  readonly chunkId: string;
  readonly text: string;
  readonly normalizedText: string;
  readonly language: LanguageCode;
  readonly metadata: DocumentMetadata;
}

export interface CompositeExtractionRecord {
  readonly chunk: ExtractionChunk;
  readonly candidateSchemas: readonly SchemaCandidate[];
  readonly candidateFacts: readonly FactCandidate[];
  readonly sourcePassage: Passage;
  readonly rawEntities: readonly string[];
}

export interface CanonicalizationResult {
  readonly canonicalHeadType: string;
  readonly canonicalRelation: string;
  readonly canonicalTailType: string;
  readonly aliases: readonly SchemaAlias[];
  readonly confidence: number;
  readonly mergedIntoSchemaId?: string;
}

export interface IExtractionAgent {
  extract(chunk: ExtractionChunk): Promise<CompositeExtractionRecord>;
}

export interface ISchemaCanonicalizer {
  canonicalize(candidate: SchemaCandidate): Promise<CanonicalizationResult>;
}
