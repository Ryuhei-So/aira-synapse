import { describe, expect, it } from 'vitest';
import retrievalFixture from '../../../fixtures/bounded-retrieval/bounded-retrieval-fixture.json';
import {
  BOUNDED_RETRIEVAL_OPERATION_NAMES,
  BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS,
  validateBoundedSemanticExchange,
  validateBoundedRetrievalStructuralDeclarations,
} from '../../../../src/domain/retrieval/boundedContract.js';
import {
  applyBoundedReplacementPatch,
  deriveBoundedAssertionCoverage,
  validateBoundedRetrievalFixture,
  type BoundedRetrievalFixture,
} from '../../../../src/domain/retrieval/boundedWitnesses.js';

const fixture = retrievalFixture as unknown as BoundedRetrievalFixture;

function containsOpcode(value: unknown, opcode: string): boolean {
  if (Array.isArray(value)) return value.some((item) => containsOpcode(item, opcode));
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(([key, child]) =>
    (key === 'op' && child === opcode) || containsOpcode(child, opcode));
}

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
    expect(validateBoundedRetrievalStructuralDeclarations({
      ...BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS,
      [operation]: {
        ...BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS[operation],
        [Symbol('hidden')]: true,
      },
    }).valid).toBe(false);

    const candidate = BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS[operation];
    const firstSlot = candidate.result.fields.slots.items[0];
    const hits = firstSlot.fields.hits;
    const hit = hits.items;
    expect(validateBoundedRetrievalStructuralDeclarations({
      ...BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS,
      [operation]: {
        ...candidate,
        result: {
          ...candidate.result,
          fields: {
            ...candidate.result.fields,
            slots: {
              ...candidate.result.fields.slots,
              items: [{
                ...firstSlot,
                fields: {
                  ...firstSlot.fields,
                  hits: {
                    ...hits,
                    items: {
                      ...hit,
                      fields: {
                        ...hit.fields,
                        item: { ...hit.fields.item, dependency: 'untrusted-domain-contract@1' },
                      },
                    },
                  },
                },
              }, ...candidate.result.fields.slots.items.slice(1)],
            },
          },
        },
      },
    }).valid).toBe(false);
  });

  it('exposes conjunction clauses as independent top-level assertions', () => {
    const expectedForEachCounts = [12, 5, 4];
    for (const [index, operation] of BOUNDED_RETRIEVAL_OPERATION_NAMES.entries()) {
      const program = BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS[operation].refinement;
      const forEachAssertions = program.exchangeAssertions.filter((assertion) => assertion.op === 'for_each');
      expect(forEachAssertions).toHaveLength(expectedForEachCounts[index]);
      expect(forEachAssertions.every((assertion) => (
        typeof assertion.predicate === 'object'
        && assertion.predicate !== null
        && !Array.isArray(assertion.predicate)
        && (assertion.predicate as { readonly op?: unknown }).op !== 'all'
      ))).toBe(true);
      expect(containsOpcode(program, 'all')).toBe(false);
    }
  });

  it('validates the canonical baseline and every embedded assertion witness', () => {
    expect(validateBoundedRetrievalFixture(fixture)).toEqual({ valid: true, errors: [] });
    const coverage = deriveBoundedAssertionCoverage();
    expect(fixture.witnesses).toHaveLength(coverage.identities.length);
    expect(fixture.witnesses.map(({ operation, partition, assertionIndex }) => ({
      operation,
      partition,
      assertionIndex,
    }))).toEqual(coverage.identities);

    for (const operation of BOUNDED_RETRIEVAL_OPERATION_NAMES) {
      const exchange = fixture.exchanges[operation];
      expect(validateBoundedSemanticExchange(operation, exchange.request, exchange.result)).toEqual({
        valid: true,
        errors: [],
      });
    }
  });

  it('applies witnesses without mutating the valid baseline', () => {
    const baseline = JSON.stringify(fixture);
    for (const witness of fixture.witnesses) {
      const exchange = fixture.exchanges[witness.operation];
      const mutated = applyBoundedReplacementPatch(exchange, witness.patch);
      if (witness.partition === 'request') {
        expect(validateBoundedSemanticExchange(
          witness.operation,
          mutated.request,
          mutated.result,
        ).valid).toBe(false);
      } else {
        expect(validateBoundedSemanticExchange(
          witness.operation,
          mutated.request,
          mutated.result,
        ).valid).toBe(false);
      }
    }
    expect(JSON.stringify(fixture)).toBe(baseline);
  });
});
