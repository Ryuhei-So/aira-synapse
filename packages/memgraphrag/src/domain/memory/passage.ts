/**
 * Domain Layer — Passage and DocumentMetadata models.
 * DES-MG-001: Passage with evidence grounding and quality assessment.
 */

import type {
  CorpusScoped,
  LanguageCode,
  Timestamped,
} from './types.js';

export interface DocumentMetadata {
  readonly documentId: string;
  readonly title: string;
  readonly sourceUrl: string;
  readonly doi?: string;
  readonly sourceDb?: string;
  readonly sourceType?: 'pdf' | 'html' | 'docx' | 'pptx' | 'md';
  readonly language: LanguageCode;
  readonly convertedAt?: string;
  readonly sectionPath: readonly string[];
  readonly chunkId: string;
  readonly chunkIndex: number;
  readonly offsetStart: number;
  readonly offsetEnd: number;
}

export interface Passage extends CorpusScoped, Timestamped {
  readonly passageId: string;
  readonly text: string;
  readonly normalizedText: string;
  readonly metadata: DocumentMetadata;
  readonly factIds: readonly string[];
  readonly entityMentions: readonly string[];
  readonly qualityFlags: readonly string[];
  readonly qualityScore?: number;
}

/**
 * Validates that offsets are non-negative and start < end.
 */
export function hasValidOffsets(metadata: DocumentMetadata): boolean {
  return (
    metadata.offsetStart >= 0 &&
    metadata.offsetEnd > metadata.offsetStart
  );
}
