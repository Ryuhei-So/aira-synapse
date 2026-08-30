import { describe, expect, it, vi } from 'vitest';
import {
  arrayContract,
  assertContractDeclaration,
  canonicalJson,
  discriminatedUnionContract,
  externalRefContract,
  literalContract,
  numberContract,
  objectContract,
  stringContract,
  validateContractDeclaration,
  validateContractNode,
  type ContractNode,
} from '../../../../src/domain/contract/structural.js';

const tagged = discriminatedUnionContract('kind', {
  alpha: objectContract({
    kind: literalContract('alpha'),
    value: stringContract(),
  }),
  beta: objectContract({
    kind: literalContract('beta'),
    value: numberContract(),
  }),
});

describe('neutral structural contract DSL', () => {
  it('preserves discriminated-union correlation and rejects invalid tags', () => {
    expect(validateContractNode(tagged, { kind: 'alpha', value: 'ok' })).toEqual({
      valid: true,
      errors: [],
    });
    expect(validateContractNode(tagged, { kind: 'beta', value: 1 })).toEqual({
      valid: true,
      errors: [],
    });
    for (const value of [
      { kind: 'alpha', value: 1 },
      { kind: 'beta', value: 'wrong' },
      { kind: 'unknown', value: 'wrong' },
      { value: 'missing-tag' },
    ]) {
      expect(validateContractNode(tagged, value).valid).toBe(false);
    }
  });

  it('fails closed when a malformed declaration makes a tag ambiguous', () => {
    const ambiguous = {
      kind: 'discriminatedUnion',
      discriminator: 'kind',
      branches: {
        first: {
          kind: 'object',
          fields: { kind: { kind: 'literal', values: ['same'] } },
        },
        second: {
          kind: 'object',
          fields: { kind: { kind: 'literal', values: ['same'] } },
        },
      },
    } as unknown as ContractNode;
    const result = validateContractNode(ambiguous, { kind: 'same' });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/ambiguous/);
    expect(validateContractDeclaration(ambiguous).valid).toBe(false);
  });

  it('delegates external references exactly and fails closed without a resolver', () => {
    const reference = externalRefContract<'passage', { passageId: string }>(
      'passage',
      'bounded-domain',
    );
    const resolver = vi.fn((node, value, path, errors: string[]) => {
      expect(node).toEqual({
        kind: 'externalRef',
        referenceKind: 'passage',
        dependency: 'bounded-domain',
      });
      expect(path).toBe('$');
      if (
        typeof value !== 'object'
        || value === null
        || (value as { passageId?: unknown }).passageId !== 'p1'
      ) {
        errors.push('$ external passage is invalid');
      }
    });
    expect(validateContractNode(reference, { passageId: 'p1' }, resolver).valid).toBe(true);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(validateContractNode(reference, { passageId: 'wrong' }, resolver).valid).toBe(false);
    expect(validateContractNode(reference, { passageId: 'p1' }).valid).toBe(false);
    expect(validateContractNode(reference, { passageId: 'p1' }, () => {
      throw new Error('resolver failed');
    }).errors.join(' ')).toMatch(/failed closed: resolver failed/);
  });

  it('rejects unknown, missing, non-finite, non-plain, sparse, and decorated values', () => {
    const contract = objectContract({
      id: stringContract(),
      values: arrayContract(numberContract()),
    });
    const sparse = Array<number>(2);
    sparse[1] = 1;
    const decorated = [1] as number[] & { extra?: boolean };
    decorated.extra = true;
    const inherited = Object.assign(
      Object.create({ inherited: true }) as Record<string, unknown>,
      { id: 'x', values: [1] },
    );
    const symbol = { id: 'x', values: [1], [Symbol('hidden')]: true };

    expect(validateContractNode(contract, { id: 'x', values: [1] }).valid).toBe(true);
    for (const value of [
      { id: 'x', values: [1], extra: true },
      { values: [1] },
      { id: 'x', values: [Number.NaN] },
      { id: 'x', values: [Number.POSITIVE_INFINITY] },
      { id: 'x', values: sparse },
      { id: 'x', values: decorated },
      inherited,
      symbol,
    ]) {
      expect(validateContractNode(contract, value).valid).toBe(false);
    }
  });

  it('validates declarations as a closed language', () => {
    expect(validateContractDeclaration(tagged).valid).toBe(true);
    expect(() => assertContractDeclaration(tagged)).not.toThrow();

    const invalidDeclarations: unknown[] = [
      { kind: 'future-node' },
      { kind: 'string', extra: true },
      { kind: 'literal', values: [] },
      { kind: 'literal', values: [Number.NaN] },
      { kind: 'array' },
      { kind: 'object', fields: { '': { kind: 'string' } } },
      {
        kind: 'discriminatedUnion',
        discriminator: '',
        branches: {},
      },
      {
        kind: 'discriminatedUnion',
        discriminator: 'kind',
        branches: {
          alpha: {
            kind: 'object',
            fields: { kind: { kind: 'literal', values: ['wrong'] } },
          },
        },
      },
      { kind: 'externalRef', referenceKind: '', dependency: 'domain' },
      { kind: 'externalRef', referenceKind: 'passage', dependency: '' },
    ];
    for (const declaration of invalidDeclarations) {
      expect(validateContractDeclaration(declaration).valid).toBe(false);
      expect(() => assertContractDeclaration(declaration)).toThrow();
    }
  });

  it('canonicalizes deterministically and rejects values outside canonical JSON', () => {
    const left = {
      z: 1,
      a: { y: [3, { b: true, a: false }], x: 'x' },
    };
    const right = {
      a: { x: 'x', y: [3, { a: false, b: true }] },
      z: 1,
    };
    const expected = [
      '{',
      '  "a": {',
      '    "x": "x",',
      '    "y": [',
      '      3,',
      '      {',
      '        "a": false,',
      '        "b": true',
      '      }',
      '    ]',
      '  },',
      '  "z": 1',
      '}',
      '',
    ].join('\n');
    expect(canonicalJson(left)).toBe(expected);
    expect(canonicalJson(right)).toBe(expected);
    const sparse = Array<number>(1);
    const decoratedArray = [1] as number[] & { extra?: boolean };
    decoratedArray.extra = true;
    const symbolField = { valid: true, [Symbol('hidden')]: true };
    for (const invalid of [
      undefined,
      1n,
      Symbol('value'),
      () => true,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      { nested: undefined },
      { nested: 1n },
      sparse,
      decoratedArray,
      symbolField,
      new Date(),
    ]) {
      expect(() => canonicalJson(invalid)).toThrow();
    }
  });
});
