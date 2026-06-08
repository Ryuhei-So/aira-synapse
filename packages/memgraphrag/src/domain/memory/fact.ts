/**
 * Domain Layer — Fact and FactCandidate models.
 * DES-MG-001, DES-MG-003: Fact with schema reference (Φ) and passage links (Ψ).
 */

import type {
  CorpusScoped,
  FactState,
  Timestamped,
} from './types.js';

export interface Fact extends CorpusScoped, Timestamped {
  readonly factId: string;
  readonly schemaId: string;
  readonly headEntity: string;
  readonly headType: string;
  readonly relation: string;
  readonly tailEntity: string;
  readonly tailType: string;
  readonly state: FactState;
  readonly passageIds: readonly string[];
  readonly sourceDocumentIds: readonly string[];
  readonly confidence: number;
  readonly temporalScope?: string;
  readonly granularityParentFactId?: string;
}

export interface FactCandidate {
  readonly headEntity: string;
  readonly headType: string;
  readonly relation: string;
  readonly tailEntity: string;
  readonly tailType: string;
  readonly supportingSpanIds: readonly string[];
  readonly confidence: number;
}

/**
 * Validates that a fact has at least one passage link (Ψ grounding).
 */
export function hasPassageGrounding(fact: Fact): boolean {
  return fact.passageIds.length > 0;
}
