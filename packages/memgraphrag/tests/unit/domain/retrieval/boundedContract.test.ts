import { describe, expect, it } from 'vitest';
import {
  BOUNDED_RETRIEVAL_OPERATION_NAMES,
  BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS,
  validateBoundedRetrievalStructuralDeclarations,
} from '../../../../src/domain/retrieval/boundedContract.js';

describe('bounded retrieval structural declaration', () => {
  it('derives the complete accepted operation set from the canonical declaration', () => {
    expect(Object.keys(BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS)).toEqual(
      BOUNDED_RETRIEVAL_OPERATION_NAMES,
    );
    expect(validateBoundedRetrievalStructuralDeclarations(
      BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS,
    )).toEqual({ valid: true, errors: [] });
  });

  it('fails closed when an element is added outside the canonical operation set', () => {
    const futureOperation = {
      ...BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS,
      'future_full_snapshot@1': BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS[
        BOUNDED_RETRIEVAL_OPERATION_NAMES[0]
      ],
    };
    expect(validateBoundedRetrievalStructuralDeclarations(futureOperation).valid).toBe(false);
    expect(validateBoundedRetrievalStructuralDeclarations({
      ...BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS,
      [Symbol('hidden')]: true,
    }).valid).toBe(false);
  });

  it('fails closed when a canonical operation or one of its sides drifts', () => {
    const missing = { ...BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS } as Record<string, unknown>;
    delete missing[BOUNDED_RETRIEVAL_OPERATION_NAMES[1]];
    expect(validateBoundedRetrievalStructuralDeclarations(missing).valid).toBe(false);

    const operation = BOUNDED_RETRIEVAL_OPERATION_NAMES[0];
    expect(validateBoundedRetrievalStructuralDeclarations({
      ...BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS,
      [operation]: {
        ...BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS[operation],
        futureSide: { kind: 'string' },
      },
    }).valid).toBe(false);
  });
});
