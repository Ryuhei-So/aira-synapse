/**
 * Domain Layer — Conflict Detection Agent port.
 * DES-MG-004: Stage III conflict detection with active fact scan.
 */

import type { Fact } from '../memory/fact.js';

export type ConflictType = 'mutually_exclusive' | 'temporal' | 'granularity';

export interface ConflictCandidate {
  readonly factId: string;
  readonly similarity: number;
  readonly symbolicMatch: boolean;
  readonly thesaurusDistance?: number;
}

export interface ConflictSet {
  readonly corpusId: string;
  readonly newFact: Fact;
  readonly conflictingFacts: readonly Fact[];
  readonly candidates: readonly ConflictCandidate[];
  readonly conflictType: ConflictType;
  readonly scanLimit: number;
}

export interface ConflictDetectionRequest {
  readonly corpusId: string;
  readonly newFact: Fact;
  readonly activeFactLimit: number;
  readonly similarityThreshold: number;
}

export interface IConflictDetector {
  detect(request: ConflictDetectionRequest): Promise<readonly ConflictSet[]>;
}
