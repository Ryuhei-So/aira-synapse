import { describe, expect, it } from 'vitest';
import { arrayContract, literalContract, numberContract, objectContract, stringContract, tupleContract } from '../../../../src/domain/contract/structural.js';
import { validateRefinementProgramPointers } from '../../../../src/domain/retrieval/refinementCompiler.js';
import { evaluateRefinementProgram, REFINEMENT_EVALUATOR_DISPATCH } from '../../../../src/domain/retrieval/refinementEvaluator.js';
import {
  REFINEMENT_IR_VERSION,
  REFINEMENT_NODE_DECLARATIONS,
  type RefinementNode,
  type RefinementProgram,
} from '../../../../src/domain/retrieval/refinementIr.js';

const pointer = (root: 'request' | 'result', path: string): RefinementNode => ({ op: 'pointer', root, path });
const iteration = (scope: string, path: string): RefinementNode => ({ op: 'iteration_pointer', scope, path });

const candidateProgram: RefinementProgram = {
  version: REFINEMENT_IR_VERSION,
  assertions: [
    {
      op: 'length_eq',
      actual: pointer('result', '/hits'),
      expected: { op: 'array_length', value: pointer('request', '/ids') },
    },
    {
      op: 'tuple_tags',
      actual: pointer('result', '/slots'),
      field: 'slotId',
      expected: ['passage', 'fact', 'schema'],
    },
    {
      op: 'unique_by',
      collection: pointer('result', '/hits'),
      scope: 'hit',
      key: iteration('hit', '/id'),
    },
    {
      op: 'ordered_score_desc_id_asc',
      collection: pointer('result', '/hits'),
      scope: 'hit',
      score: iteration('hit', '/score'),
      id: iteration('hit', '/id'),
      idOrder: 'unicode_utf16_code_unit_asc',
    },
    {
      op: 'finite_range',
      value: pointer('result', '/hits/*/score'),
      minimum: -1,
      maximum: 1,
    },
  ],
};

const context = (hits: readonly unknown[]) => ({
  request: { ids: ['a', 'b'] },
  result: {
    slots: [{ slotId: 'passage' }, { slotId: 'fact' }, { slotId: 'schema' }],
    hits,
  },
  normalize: (_dependency: string, value: string) => value.toLowerCase(),
});

const structuralRoots = {
  request: objectContract({ ids: arrayContract(stringContract()) }),
  result: objectContract({
    slots: arrayContract(objectContract({ slotId: stringContract() })),
    hits: arrayContract(objectContract({ id: stringContract(), score: numberContract() })),
  }),
  resolveExternal: () => undefined,
};

describe('refinement evaluator', () => {
  it('binds executable dispatch exactly to the canonical opcode set', () => {
    expect(Object.keys(REFINEMENT_EVALUATOR_DISPATCH)).toEqual(Object.keys(REFINEMENT_NODE_DECLARATIONS));
  });

  it('executes collection, pointer, ordering, identity, and range semantics', () => {
    expect(() => evaluateRefinementProgram(candidateProgram, context([
      { id: 'a', score: 0.9 },
      { id: 'b', score: 0.8 },
    ]), structuralRoots)).not.toThrow();
  });

  it('fails closed for duplicate, misordered, out-of-range, and undeclared cases', () => {
    for (const hits of [
      [{ id: 'a', score: 0.9 }, { id: 'a', score: 0.8 }],
      [{ id: 'b', score: 0.8 }, { id: 'a', score: 0.9 }],
      [{ id: 'a', score: 1.1 }, { id: 'b', score: 0.8 }],
    ]) {
      expect(() => evaluateRefinementProgram(candidateProgram, context(hits), structuralRoots)).toThrow(/failed closed/);
    }
    expect(() => evaluateRefinementProgram({
      version: REFINEMENT_IR_VERSION,
      assertions: [{ op: 'future_full_snapshot' } as unknown as RefinementNode],
    }, context([]), structuralRoots)).toThrow(/failed closed/);
  });

  it('rejects a schema-unknown pointer even when its wildcard collection is empty', () => {
    const typoProgram: RefinementProgram = {
      version: REFINEMENT_IR_VERSION,
      assertions: [{
        op: 'finite_range',
        value: pointer('result', '/hits/*/typo'),
        minimum: -1,
        maximum: 1,
      }],
    };
    expect(() => evaluateRefinementProgram(typoProgram, context([]), structuralRoots)).toThrow(/field typo is absent/);
  });

  it('resolves fixed tuple branches by index and rejects a branch-erasing wildcard', () => {
    const tupleRoots = {
      request: objectContract({}),
      result: objectContract({
        slots: tupleContract(
          objectContract({
            slotId: literalContract('passage'),
            hits: arrayContract(objectContract({ item: objectContract({ passageId: stringContract() }) })),
          }),
          objectContract({
            slotId: literalContract('fact'),
            hits: arrayContract(objectContract({ item: objectContract({ factId: stringContract() }) })),
          }),
        ),
      }),
      resolveExternal: () => undefined,
    };
    const withPath = (path: string): RefinementProgram => ({
      version: REFINEMENT_IR_VERSION,
      assertions: [{ op: 'field_eq_ref', value: pointer('result', path), expected: { op: 'literal', value: 'p1' } }],
    });
    expect(validateRefinementProgramPointers(withPath('/slots/0/hits/*/item/passageId'), tupleRoots).valid).toBe(true);
    expect(validateRefinementProgramPointers(withPath('/slots/*/hits/*/item/passageId'), tupleRoots).valid).toBe(false);
  });
});
