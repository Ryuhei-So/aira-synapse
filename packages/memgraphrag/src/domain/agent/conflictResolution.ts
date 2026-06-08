/**
 * Domain Layer — Conflict Resolution Agent port.
 * DES-MG-005: Six resolution states with evidence-based adjudication.
 */

import type { Fact } from '../memory/fact.js';
import type { Passage } from '../memory/passage.js';
import type { ConflictSet } from './conflictDetection.js';

export type ConflictResolutionState =
  | 'resolved_keep_new'
  | 'resolved_keep_existing'
  | 'merged'
  | 'temporalized'
  | 'granularity_linked'
  | 'unresolved';

const RESOLUTION_STATES = new Set<string>([
  'resolved_keep_new',
  'resolved_keep_existing',
  'merged',
  'temporalized',
  'granularity_linked',
  'unresolved',
]);

export function isConflictResolutionState(
  value: unknown,
): value is ConflictResolutionState {
  return typeof value === 'string' && RESOLUTION_STATES.has(value);
}

export interface ResolutionEvidence {
  readonly passageId: string;
  readonly supportsFactIds: readonly string[];
  readonly rationale: string;
}

export interface ConflictResolution {
  readonly state: ConflictResolutionState;
  readonly confidence: number;
  readonly keptFactIds: readonly string[];
  readonly inactivatedFactIds: readonly string[];
  readonly derivedFacts: readonly Fact[];
  readonly evidence: readonly ResolutionEvidence[];
}

export interface ConflictResolutionRequest {
  readonly conflictSet: ConflictSet;
  readonly evidencePassages: readonly Passage[];
}

export interface IConflictResolver {
  resolve(request: ConflictResolutionRequest): Promise<ConflictResolution>;
}

/**
 * Validates that a resolution has at least one evidence entry.
 */
export function hasRequiredEvidence(resolution: ConflictResolution): boolean {
  return resolution.evidence.length > 0;
}

/**
 * Validates that keptFactIds and inactivatedFactIds don't overlap.
 */
export function hasNoFactOverlap(resolution: ConflictResolution): boolean {
  const kept = new Set(resolution.keptFactIds);
  return !resolution.inactivatedFactIds.some((id) => kept.has(id));
}
