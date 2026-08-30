import { describe, expect, it } from 'vitest';
import {
  REFINEMENT_IR_VERSION,
  REFINEMENT_NODE_DECLARATIONS,
  validateRefinementNode,
  validateRefinementProgram,
  type RefinementFieldKind,
  type RefinementNode,
  type RefinementOpcode,
} from '../../../../src/domain/retrieval/refinementIr.js';

const literal = (): RefinementNode => ({ op: 'literal', value: 0 });

function fieldValue(kind: RefinementFieldKind): unknown {
  switch (kind) {
    case 'string': return '/value';
    case 'number': return 0;
    case 'boolean': return true;
    case 'scalar': return 0;
    case 'root': return 'request';
    case 'json_pointer': return '/value';
    case 'id_order': return 'unicode_utf16_code_unit_asc';
    case 'string_array': return ['passage'];
    case 'expression': return literal();
    case 'expression_array_nonempty': return [literal()];
  }
}

function minimalNode(op: RefinementOpcode): RefinementNode {
  const declaration = REFINEMENT_NODE_DECLARATIONS[op];
  return {
    op,
    ...Object.fromEntries(
      Object.entries(declaration.fields).map(([field, kind]) => [
        field,
        field === 'scope' ? 'item' : fieldValue(kind),
      ]),
    ),
  };
}

describe('closed refinement IR', () => {
  it('binds executable cases to every canonical opcode', () => {
    const cases = Object.keys(REFINEMENT_NODE_DECLARATIONS) as RefinementOpcode[];
    expect(cases.length).toBeGreaterThan(0);
    for (const op of cases) {
      const declaration = REFINEMENT_NODE_DECLARATIONS[op];
      expect(validateRefinementNode(minimalNode(op), declaration.role, ['item'])).toEqual({
        valid: true,
        errors: [],
      });
    }
  });

  it('rejects an element added outside the canonical opcode declaration', () => {
    const future = { op: 'future_full_snapshot', value: literal() };
    expect(validateRefinementNode(future, 'expression').valid).toBe(false);
    expect(validateRefinementProgram({
      version: REFINEMENT_IR_VERSION,
      requestAssertions: [],
      exchangeAssertions: [future],
    }).valid).toBe(false);
  });

  it('rejects role, field, version, and recursive-shape drift', () => {
    expect(validateRefinementNode(minimalNode('literal'), 'assertion').valid).toBe(false);
    expect(validateRefinementNode({ ...minimalNode('eq'), future: true }, 'expression').valid).toBe(false);
    expect(validateRefinementNode({ op: 'eq', left: literal() }, 'expression').valid).toBe(false);
    expect(validateRefinementNode({ op: 'pointer', root: 'native', path: 'not-a-pointer' }, 'expression').valid).toBe(false);
    expect(validateRefinementNode({ op: 'max', values: [] }, 'expression').valid).toBe(false);
    expect(validateRefinementNode({ op: 'iteration_pointer', scope: 'missing', path: '/id' }, 'expression').valid).toBe(false);
    expect(validateRefinementProgram({
      version: 'future-version',
      requestAssertions: [],
      exchangeAssertions: [minimalNode('finite_range')],
    }).valid).toBe(false);

    const cyclic: Record<string, unknown> = { op: 'not' };
    cyclic.value = cyclic;
    expect(validateRefinementNode(cyclic, 'expression').valid).toBe(false);

    const sparse = Array<RefinementNode>(1);
    expect(validateRefinementProgram({ version: REFINEMENT_IR_VERSION, requestAssertions: sparse, exchangeAssertions: [] }).valid).toBe(false);
    const decorated = [minimalNode('finite_range')] as RefinementNode[] & { future?: boolean };
    decorated.future = true;
    expect(validateRefinementProgram({ version: REFINEMENT_IR_VERSION, requestAssertions: [], exchangeAssertions: decorated }).valid).toBe(false);
    expect(validateRefinementProgram({
      version: REFINEMENT_IR_VERSION,
      requestAssertions: [],
      exchangeAssertions: [],
      requestAssertionCount: 0,
    }).valid).toBe(false);
  });

  it('accepts a program containing every canonical assertion case', () => {
    const assertions = (Object.keys(REFINEMENT_NODE_DECLARATIONS) as RefinementOpcode[])
      .filter((op) => REFINEMENT_NODE_DECLARATIONS[op].role === 'assertion')
      .map(minimalNode);
    expect(validateRefinementProgram({ version: REFINEMENT_IR_VERSION, requestAssertions: [], exchangeAssertions: assertions })).toEqual({
      valid: true,
      errors: [],
    });
  });
});
