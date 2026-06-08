import { describe, expect, it } from 'vitest';
import {
  hasNoFactOverlap,
  hasRequiredEvidence,
  isConflictResolutionState,
} from '../../../../src/domain/agent/conflictResolution.js';
import type { ConflictResolution } from '../../../../src/domain/agent/conflictResolution.js';

describe('TASK-MG-012: conflict resolution contracts', () => {
  it('accepts all supported conflict resolution states and rejects invalid values', () => {
    expect(isConflictResolutionState('resolved_keep_new')).toBe(true);
    expect(isConflictResolutionState('resolved_keep_existing')).toBe(true);
    expect(isConflictResolutionState('merged')).toBe(true);
    expect(isConflictResolutionState('temporalized')).toBe(true);
    expect(isConflictResolutionState('granularity_linked')).toBe(true);
    expect(isConflictResolutionState('unresolved')).toBe(true);

    expect(isConflictResolutionState('pending')).toBe(false);
    expect(isConflictResolutionState('')).toBe(false);
    expect(isConflictResolutionState(0)).toBe(false);
  });

  it('requires at least one evidence entry', () => {
    expect(hasRequiredEvidence(makeResolution([{ passageId: 'passage-1', supportsFactIds: ['fact-1'], rationale: 'Direct support' }]))).toBe(true);
    expect(hasRequiredEvidence(makeResolution([]))).toBe(false);
  });

  it('returns true only when kept and inactivated fact ids do not overlap', () => {
    expect(hasNoFactOverlap(makeResolution([], ['fact-1'], ['fact-2']))).toBe(true);
    expect(hasNoFactOverlap(makeResolution([], ['fact-1'], ['fact-1']))).toBe(false);
  });
});

function makeResolution(
  evidence: ConflictResolution['evidence'],
  keptFactIds: readonly string[] = ['fact-1'],
  inactivatedFactIds: readonly string[] = ['fact-2'],
): ConflictResolution {
  return {
    state: 'resolved_keep_new',
    confidence: 0.9,
    keptFactIds,
    inactivatedFactIds,
    derivedFacts: [],
    evidence,
  };
}
