import {
  REFINEMENT_NODE_DECLARATIONS,
  type RefinementNode,
  type RefinementOpcode,
  type RefinementProgram,
} from './refinementIr.js';
import {
  validateRefinementProgramPointers,
  type RefinementStructuralRoots,
} from './refinementCompiler.js';

export interface RefinementEvaluationContext {
  readonly request: unknown;
  readonly result: unknown;
  readonly normalize: (dependency: string, value: string) => string;
}

type Scope = Readonly<Record<string, unknown>>;
type Handler = (node: RefinementNode, context: RefinementEvaluationContext, scope: Scope) => unknown;

function fail(message: string): never {
  throw new TypeError(`refinement evaluation failed closed: ${message}`);
}

function field(node: RefinementNode, name: string): unknown {
  return node[name];
}

function expression(node: RefinementNode, name: string): RefinementNode {
  return field(node, name) as RefinementNode;
}

function expressions(node: RefinementNode, name: string): readonly RefinementNode[] {
  return field(node, name) as readonly RefinementNode[];
}

function decodePointerSegment(segment: string): string {
  return segment.replace(/~1/gu, '/').replace(/~0/gu, '~');
}

function resolvePath(value: unknown, path: string): unknown {
  if (path === '') return value;
  let values: unknown[] = [value];
  for (const rawSegment of path.slice(1).split('/')) {
    const segment = decodePointerSegment(rawSegment);
    if (segment === '*') {
      values = values.flatMap((entry) => {
        if (!Array.isArray(entry)) return fail(`wildcard requires an array at ${path}`);
        return entry;
      });
      continue;
    }
    values = values.map((entry) => {
      if (typeof entry !== 'object' || entry === null
        || !Object.prototype.hasOwnProperty.call(entry, segment)) {
        return fail(`unresolved pointer ${path}`);
      }
      return (entry as Record<string, unknown>)[segment];
    });
  }
  return values.length === 1 ? values[0] : values;
}

function evaluate(node: RefinementNode, context: RefinementEvaluationContext, scope: Scope): unknown {
  const handler = REFINEMENT_EVALUATOR_DISPATCH[node.op];
  if (!handler) return fail(`unknown opcode ${String(node.op)}`);
  return handler(node, context, scope);
}

function values(node: RefinementNode, context: RefinementEvaluationContext, scope: Scope): unknown[] {
  return expressions(node, 'values').map((item) => evaluate(item, context, scope));
}

function asArray(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value)) return fail(`${name} must be an array`);
  return value;
}

function asFinite(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fail(`${name} must be finite`);
  return value;
}

function asBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') return fail(`${name} must be boolean`);
  return value;
}

function asString(value: unknown, name: string): string {
  if (typeof value !== 'string') return fail(`${name} must be string`);
  return value;
}

function asComparableScalar(value: unknown, name: string): string | number | boolean | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))) return value;
  return fail(`${name} must be a canonical JSON scalar`);
}

function scalarEqual(left: string | number | boolean | null, right: string | number | boolean | null): boolean {
  return left === right;
}

function binary(node: RefinementNode, context: RefinementEvaluationContext, scope: Scope): [unknown, unknown] {
  return [evaluate(expression(node, 'left'), context, scope), evaluate(expression(node, 'right'), context, scope)];
}

function everyLeaf(value: unknown, predicate: (leaf: unknown) => boolean): boolean {
  return Array.isArray(value) ? value.every((item) => everyLeaf(item, predicate)) : predicate(value);
}

function pairwise(left: unknown, right: unknown, predicate: (a: unknown, b: unknown) => boolean): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => pairwise(item, right[index], predicate));
  }
  return predicate(left, right);
}

function collectionScope(node: RefinementNode, item: unknown, scope: Scope): Scope {
  return { ...scope, [asString(field(node, 'scope'), 'scope')]: item };
}

/** Every canonical opcode must have one executable handler. */
export const REFINEMENT_EVALUATOR_DISPATCH = {
  literal: (node) => field(node, 'value'),
  pointer: (node, context) => resolvePath(
    field(node, 'root') === 'request' ? context.request : context.result,
    asString(field(node, 'path'), 'pointer path'),
  ),
  iteration_pointer: (node, _context, scope) => resolvePath(
    scope[asString(field(node, 'scope'), 'iteration scope')],
    asString(field(node, 'path'), 'iteration path'),
  ),
  array_length: (node, context, scope) => asArray(evaluate(expression(node, 'value'), context, scope), 'array_length').length,
  array_at: (node, context, scope) => {
    const array = asArray(evaluate(expression(node, 'array'), context, scope), 'array_at');
    const index = asFinite(evaluate(expression(node, 'index'), context, scope), 'array index');
    if (!Number.isSafeInteger(index) || index < 0 || index >= array.length) return fail('array index is out of range');
    return array[index];
  },
  set_contains: (node, context, scope) => {
    const expected = asComparableScalar(evaluate(expression(node, 'value'), context, scope), 'set value');
    return asArray(evaluate(expression(node, 'set'), context, scope), 'set')
      .some((candidate) => scalarEqual(asComparableScalar(candidate, 'set candidate'), expected));
  },
  map_lookup: (node, context, scope) => {
    const map = evaluate(expression(node, 'map'), context, scope);
    const key = asComparableScalar(evaluate(expression(node, 'key'), context, scope), 'map key');
    const keyField = asString(field(node, 'keyField'), 'map key field');
    const valueField = asString(field(node, 'valueField'), 'map value field');
    const entries = asArray(map, 'map lookup');
    const match = entries.find((entry) => typeof entry === 'object' && entry !== null
      && scalarEqual(asComparableScalar((entry as Record<string, unknown>)[keyField], 'map entry key'), key));
    if (!match) return null;
    if (!Object.prototype.hasOwnProperty.call(match, valueField)) return fail(`map value field ${valueField} is absent`);
    return (match as Record<string, unknown>)[valueField];
  },
  normalize_ref: (node, context, scope) => context.normalize(
    asString(field(node, 'dependency'), 'normalization dependency'),
    asString(evaluate(expression(node, 'value'), context, scope), 'normalization value'),
  ),
  concat: (node, context, scope) => values(node, context, scope).map((value) => asString(value, 'concat value')).join(''),
  coalesce: (node, context, scope) => values(node, context, scope).find((value) => value !== null) ?? null,
  max: (node, context, scope) => Math.max(...values(node, context, scope).map((value) => asFinite(value, 'max value'))),
  multiply: (node, context, scope) => {
    const [left, right] = binary(node, context, scope);
    return asFinite(left, 'multiply left') * asFinite(right, 'multiply right');
  },
  eq: (node, context, scope) => {
    const [left, right] = binary(node, context, scope);
    return pairwise(left, right, (a, b) => scalarEqual(
      asComparableScalar(a, 'eq left'),
      asComparableScalar(b, 'eq right'),
    ));
  },
  lt: (node, context, scope) => {
    const [left, right] = binary(node, context, scope);
    return pairwise(left, right, (a, b) => asFinite(a, 'lt left') < asFinite(b, 'lt right'));
  },
  lte: (node, context, scope) => {
    const [left, right] = binary(node, context, scope);
    return pairwise(left, right, (a, b) => asFinite(a, 'lte left') <= asFinite(b, 'lte right'));
  },
  not: (node, context, scope) => !asBoolean(evaluate(expression(node, 'value'), context, scope), 'not value'),
  all: (node, context, scope) => values(node, context, scope).every((value) => asBoolean(value, 'all value')),
  any: (node, context, scope) => values(node, context, scope).some((value) => asBoolean(value, 'any value')),
  length_eq: (node, context, scope) => {
    const actual = asArray(evaluate(expression(node, 'actual'), context, scope), 'length_eq actual');
    const expected = asFinite(evaluate(expression(node, 'expected'), context, scope), 'length_eq expected');
    return actual.length === expected;
  },
  length_lte_ref: (node, context, scope) => {
    const actual = evaluate(expression(node, 'actual'), context, scope);
    const limit = evaluate(expression(node, 'limit'), context, scope);
    if (Array.isArray(actual) && Array.isArray(limit)) {
      return actual.length === limit.length && actual.every((item, index) => asArray(item, 'length_lte item').length <= asFinite(limit[index], 'length limit'));
    }
    return asArray(actual, 'length_lte actual').length <= asFinite(limit, 'length limit');
  },
  tuple_tags: (node, context, scope) => {
    const actual = asArray(evaluate(expression(node, 'actual'), context, scope), 'tuple_tags actual');
    const tagField = asString(field(node, 'field'), 'tuple tag field');
    const expected = field(node, 'expected') as readonly string[];
    return actual.length === expected.length && actual.every((item, index) => (
      typeof item === 'object' && item !== null
      && (item as Record<string, unknown>)[tagField] === expected[index]
    ));
  },
  unique_by: (node, context, scope) => {
    const collection = asArray(evaluate(expression(node, 'collection'), context, scope), 'unique collection');
    const keys = collection.map((item) => asComparableScalar(
      evaluate(expression(node, 'key'), context, collectionScope(node, item, scope)),
      'unique key',
    ));
    return keys.every((key, index) => keys.findIndex((candidate) => scalarEqual(candidate, key)) === index);
  },
  ordered_score_desc_id_asc: (node, context, scope) => {
    if (field(node, 'idOrder') !== 'unicode_utf16_code_unit_asc') return fail('unknown id order');
    const collection = asArray(evaluate(expression(node, 'collection'), context, scope), 'ordered collection');
    const pairs = collection.map((item) => {
      const itemScope = collectionScope(node, item, scope);
      return {
        score: asFinite(evaluate(expression(node, 'score'), context, itemScope), 'ordered score'),
        id: asString(evaluate(expression(node, 'id'), context, itemScope), 'ordered id'),
      };
    });
    return pairs.every((item, index) => index === 0 || pairs[index - 1]!.score > item.score
      || (pairs[index - 1]!.score === item.score && pairs[index - 1]!.id < item.id));
  },
  for_each: (node, context, scope) => asArray(
    evaluate(expression(node, 'collection'), context, scope),
    'for_each collection',
  ).every((item) => asBoolean(
    evaluate(expression(node, 'predicate'), context, collectionScope(node, item, scope)),
    'for_each predicate',
  )),
  finite_range: (node, context, scope) => everyLeaf(
    evaluate(expression(node, 'value'), context, scope),
    (value) => typeof value === 'number' && Number.isFinite(value)
      && value >= asFinite(field(node, 'minimum'), 'minimum')
      && value <= asFinite(field(node, 'maximum'), 'maximum'),
  ),
  safe_integer_range: (node, context, scope) => pairwise(
    evaluate(expression(node, 'value'), context, scope),
    evaluate(expression(node, 'maximum'), context, scope),
    (value, maximum) => typeof value === 'number' && Number.isSafeInteger(value)
      && value >= asFinite(field(node, 'minimum'), 'minimum')
      && value <= asFinite(maximum, 'maximum'),
  ),
  field_eq_ref: (node, context, scope) => pairwise(
    evaluate(expression(node, 'value'), context, scope),
    evaluate(expression(node, 'expected'), context, scope),
    (a, b) => scalarEqual(asComparableScalar(a, 'field value'), asComparableScalar(b, 'field expected')),
  ),
  prefixed_identity: (node, context, scope) => pairwise(
    evaluate(expression(node, 'value'), context, scope),
    evaluate(expression(node, 'identity'), context, scope),
    (value, identity) => value === `${asString(field(node, 'prefix'), 'identity prefix')}:${asString(identity, 'identity')}`,
  ),
  corpus_eq_ref: (node, context, scope) => pairwise(
    evaluate(expression(node, 'corpus'), context, scope),
    evaluate(expression(node, 'expected'), context, scope),
    (a, b) => scalarEqual(asComparableScalar(a, 'corpus value'), asComparableScalar(b, 'corpus expected')),
  ),
  rank_is_index_plus_one: (node, context, scope) => asArray(
    evaluate(expression(node, 'collection'), context, scope),
    'rank collection',
  ).every((item, index) => evaluate(expression(node, 'rank'), context, collectionScope(node, item, scope)) === index + 1),
} as const satisfies Readonly<Record<RefinementOpcode, Handler>>;

export function evaluateRefinementProgram(
  program: RefinementProgram,
  context: RefinementEvaluationContext,
  structuralRoots: RefinementStructuralRoots,
): void {
  const validation = validateRefinementProgramPointers(program, structuralRoots);
  if (!validation.valid) fail(validation.errors.join('; '));
  for (const assertion of [...program.requestAssertions, ...program.exchangeAssertions]) {
    const declaration = REFINEMENT_NODE_DECLARATIONS[assertion.op];
    if (declaration.role !== 'assertion') fail(`${assertion.op} is not an assertion`);
    if (evaluate(assertion, context, {}) !== true) fail(`assertion ${assertion.op} was false`);
  }
}

export function evaluateRefinementRequest(
  program: RefinementProgram,
  request: unknown,
  structuralRoots: RefinementStructuralRoots,
): void {
  const validation = validateRefinementProgramPointers(program, structuralRoots);
  if (!validation.valid) fail(validation.errors.join('; '));
  const context: RefinementEvaluationContext = {
    request,
    result: undefined,
    normalize: () => fail('request assertion cannot normalize without an explicit dependency resolver'),
  };
  for (const assertion of program.requestAssertions) {
    if (evaluate(assertion, context, {}) !== true) fail(`request assertion ${assertion.op} was false`);
  }
}
