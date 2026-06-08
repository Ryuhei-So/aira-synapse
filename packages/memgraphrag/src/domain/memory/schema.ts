/**
 * Domain Layer — Schema and SchemaCandidate models.
 * DES-MG-001, DES-MG-003: Schema with canonical key, aliases, frequency, state.
 */

import type {
  CorpusScoped,
  LanguageCode,
  ProvenanceSource,
  SchemaState,
  Timestamped,
} from './types.js';

export interface SchemaAlias {
  readonly label: string;
  readonly language: LanguageCode;
  readonly source: ProvenanceSource;
  readonly confidence: number;
  readonly isCanonical: boolean;
}

export interface Schema extends CorpusScoped, Timestamped {
  readonly schemaId: string;
  readonly headType: string;
  readonly relation: string;
  readonly tailType: string;
  readonly canonicalKey: string;
  readonly aliases: readonly SchemaAlias[];
  readonly frequency: number;
  readonly state: SchemaState;
  readonly stabilizationThreshold: number;
  readonly factIds: readonly string[];
  readonly sourceDocumentIds: readonly string[];
  readonly version: number;
}

export interface SchemaCandidate {
  readonly headType: string;
  readonly relation: string;
  readonly tailType: string;
  readonly canonicalKey: string;
  readonly aliases: readonly SchemaAlias[];
  readonly confidence: number;
}

/**
 * Validates that exactly one alias in the set is marked as canonical.
 */
export function hasExactlyOneCanonicalAlias(
  aliases: readonly SchemaAlias[],
): boolean {
  return aliases.filter((a) => a.isCanonical).length === 1;
}

/**
 * Determines if a schema should be promoted to stable state.
 * State(o) = stable if Freq(o) ≥ τ else pending
 */
export function shouldPromoteToStable(
  frequency: number,
  stabilizationThreshold: number,
): boolean {
  return frequency >= stabilizationThreshold;
}

/**
 * Computes canonical key from normalized types and relation.
 * canonicalKey = normalize(headType) + "::" + relation + "::" + normalize(tailType)
 */
export function computeCanonicalKey(
  headType: string,
  relation: string,
  tailType: string,
): string {
  return `${headType.toLowerCase().trim()}::${relation.toLowerCase().trim()}::${tailType.toLowerCase().trim()}`;
}
