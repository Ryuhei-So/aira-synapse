/** Portable, closed refinement language for the Synapse-owned wire contract. */

export const REFINEMENT_IR_VERSION = 'aira-synapse-refinement-ir@1' as const;

export type RefinementFieldKind =
  | 'string'
  | 'number'
  | 'boolean'
  | 'scalar'
  | 'root'
  | 'json_pointer'
  | 'id_order'
  | 'string_array'
  | 'expression'
  | 'expression_array_nonempty';

export interface RefinementNodeDeclaration {
  readonly role: 'expression' | 'assertion';
  readonly fields: Readonly<Record<string, RefinementFieldKind>>;
}

const expression = (
  fields: Readonly<Record<string, RefinementFieldKind>>,
): RefinementNodeDeclaration => ({ role: 'expression', fields });
const assertion = (
  fields: Readonly<Record<string, RefinementFieldKind>>,
): RefinementNodeDeclaration => ({ role: 'assertion', fields });

/**
 * The sole opcode and field-shape authority. Validators, artifact generation,
 * completeness tests, and downstream implementations consume these entries.
 */
export const REFINEMENT_NODE_DECLARATIONS = {
  literal: expression({ value: 'scalar' }),
  pointer: expression({ root: 'root', path: 'json_pointer' }),
  iteration_pointer: expression({ scope: 'string', path: 'json_pointer' }),
  array_length: expression({ value: 'expression' }),
  array_at: expression({ array: 'expression', index: 'expression' }),
  set_contains: expression({ set: 'expression', value: 'expression' }),
  map_lookup: expression({ map: 'expression', key: 'expression' }),
  normalize_ref: expression({ dependency: 'string', value: 'expression' }),
  concat: expression({ values: 'expression_array_nonempty' }),
  coalesce: expression({ values: 'expression_array_nonempty' }),
  max: expression({ values: 'expression_array_nonempty' }),
  multiply: expression({ left: 'expression', right: 'expression' }),
  eq: expression({ left: 'expression', right: 'expression' }),
  lt: expression({ left: 'expression', right: 'expression' }),
  lte: expression({ left: 'expression', right: 'expression' }),
  not: expression({ value: 'expression' }),
  all: expression({ values: 'expression_array_nonempty' }),
  any: expression({ values: 'expression_array_nonempty' }),
  length_eq: assertion({ actual: 'expression', expected: 'expression' }),
  length_lte_ref: assertion({ actual: 'expression', limit: 'expression' }),
  tuple_tags: assertion({ actual: 'expression', field: 'string', expected: 'string_array' }),
  unique_by: assertion({ collection: 'expression', scope: 'string', key: 'expression' }),
  ordered_score_desc_id_asc: assertion({ collection: 'expression', scope: 'string', score: 'expression', id: 'expression', idOrder: 'id_order' }),
  finite_range: assertion({ value: 'expression', minimum: 'number', maximum: 'number' }),
  safe_integer_range: assertion({ value: 'expression', minimum: 'number', maximum: 'expression' }),
  field_eq_ref: assertion({ value: 'expression', expected: 'expression' }),
  prefixed_identity: assertion({ value: 'expression', prefix: 'string', identity: 'expression' }),
  corpus_eq_ref: assertion({ corpus: 'expression', expected: 'expression' }),
  rank_is_index_plus_one: assertion({ collection: 'expression', scope: 'string', rank: 'expression' }),
} as const satisfies Readonly<Record<string, RefinementNodeDeclaration>>;

export type RefinementOpcode = keyof typeof REFINEMENT_NODE_DECLARATIONS;
export type RefinementNode = Readonly<{ op: RefinementOpcode } & Record<string, unknown>>;

export interface RefinementProgram {
  readonly version: typeof REFINEMENT_IR_VERSION;
  readonly assertions: readonly RefinementNode[];
}

export interface RefinementValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownStringKeys(value: object, path: string, errors: string[]): string[] {
  const keys: string[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') errors.push(`${path}.${key.toString()} is unknown`);
    else keys.push(key);
  }
  return keys;
}

function validateExpression(
  value: unknown,
  path: string,
  errors: string[],
  ancestors: Set<object>,
  scopes: ReadonlySet<string>,
): void {
  validateNode(value, 'expression', path, errors, ancestors, scopes);
}

function validateField(
  kind: RefinementFieldKind,
  value: unknown,
  path: string,
  errors: string[],
  ancestors: Set<object>,
  scopes: ReadonlySet<string>,
): void {
  if (kind === 'string') {
    if (typeof value !== 'string' || value.length === 0) errors.push(`${path} must be a non-empty string`);
    return;
  }
  if (kind === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(`${path} must be finite`);
    return;
  }
  if (kind === 'boolean') {
    if (typeof value !== 'boolean') errors.push(`${path} must be boolean`);
    return;
  }
  if (kind === 'root') {
    if (value !== 'request' && value !== 'result') errors.push(`${path} must be request or result`);
    return;
  }
  if (kind === 'json_pointer') {
    if (typeof value !== 'string' || (value !== '' && (
      !value.startsWith('/')
      || value.slice(1).split('/').some((segment) => /~(?![01])/u.test(segment))
    ))) {
      errors.push(`${path} must be a canonical JSON Pointer`);
    }
    return;
  }
  if (kind === 'id_order') {
    if (value !== 'unicode_utf16_code_unit_asc') {
      errors.push(`${path} must be unicode_utf16_code_unit_asc`);
    }
    return;
  }
  if (kind === 'scalar') {
    if (value !== null && typeof value !== 'string' && typeof value !== 'boolean'
      && (typeof value !== 'number' || !Number.isFinite(value))) {
      errors.push(`${path} must be a canonical JSON scalar`);
    }
    return;
  }
  if (kind === 'expression') {
    validateExpression(value, path, errors, ancestors, scopes);
    return;
  }
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return;
  }
  if (Object.getPrototypeOf(value) !== Array.prototype) errors.push(`${path} must be a plain array`);
  for (const key of Reflect.ownKeys(value)) {
    const index = typeof key === 'string' && /^(0|[1-9]\d*)$/u.test(key) ? Number(key) : -1;
    if (key !== 'length' && (!Number.isSafeInteger(index) || index < 0 || index >= value.length)) {
      errors.push(`${path}.${String(key)} is unknown`);
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      errors.push(`${path}[${index}] must not be sparse`);
      continue;
    }
    const item = value[index];
    if (kind === 'string_array') {
      if (typeof item !== 'string') errors.push(`${path}[${index}] must be a string`);
    } else {
      validateExpression(item, `${path}[${index}]`, errors, ancestors, scopes);
    }
  }
  if (kind === 'expression_array_nonempty' && value.length === 0) {
    errors.push(`${path} must not be empty`);
  }
}

function validateNode(
  value: unknown,
  expectedRole: 'expression' | 'assertion',
  path: string,
  errors: string[],
  ancestors: Set<object>,
  scopes: ReadonlySet<string>,
): void {
  if (!isPlainRecord(value)) {
    errors.push(`${path} must be a plain object`);
    return;
  }
  if (ancestors.has(value)) {
    errors.push(`${path} must not contain a cycle`);
    return;
  }
  ancestors.add(value);
  try {
    const op = value.op;
    if (typeof op !== 'string' || !Object.prototype.hasOwnProperty.call(REFINEMENT_NODE_DECLARATIONS, op)) {
      errors.push(`${path}.op is unknown`);
      return;
    }
    const declaration = REFINEMENT_NODE_DECLARATIONS[op as RefinementOpcode];
    if (declaration.role !== expectedRole) {
      errors.push(`${path}.${op} is not an ${expectedRole}`);
      return;
    }
    if (op === 'iteration_pointer'
      && (typeof value.scope !== 'string' || !scopes.has(value.scope))) {
      errors.push(`${path}.scope is not bound by its assertion`);
    }
    const childScopes = declaration.role === 'assertion' && typeof value.scope === 'string'
      ? new Set([...scopes, value.scope])
      : scopes;
    const allowed = new Set(['op', ...Object.keys(declaration.fields)]);
    for (const key of ownStringKeys(value, path, errors)) {
      if (!allowed.has(key)) errors.push(`${path}.${key} is unknown`);
    }
    for (const [field, kind] of Object.entries(declaration.fields)) {
      if (!Object.prototype.hasOwnProperty.call(value, field)) {
        errors.push(`${path}.${field} is required`);
      } else {
        validateField(kind, value[field], `${path}.${field}`, errors, ancestors, childScopes);
      }
    }
  } finally {
    ancestors.delete(value);
  }
}

export function validateRefinementNode(
  value: unknown,
  expectedRole: 'expression' | 'assertion',
  availableScopes: readonly string[] = [],
): RefinementValidation {
  const errors: string[] = [];
  validateNode(value, expectedRole, '$', errors, new Set(), new Set(availableScopes));
  return { valid: errors.length === 0, errors };
}

export function validateRefinementProgram(value: unknown): RefinementValidation {
  const errors: string[] = [];
  if (!isPlainRecord(value)) return { valid: false, errors: ['$ must be a plain object'] };
  const keys = ownStringKeys(value, '$', errors);
  for (const key of keys) {
    if (key !== 'version' && key !== 'assertions') errors.push(`$.${key} is unknown`);
  }
  if (value.version !== REFINEMENT_IR_VERSION) errors.push('$.version is unknown');
  if (!Array.isArray(value.assertions)) {
    errors.push('$.assertions must be an array');
  } else {
    if (Object.getPrototypeOf(value.assertions) !== Array.prototype) {
      errors.push('$.assertions must be a plain array');
    }
    for (const key of Reflect.ownKeys(value.assertions)) {
      const index = typeof key === 'string' && /^(0|[1-9]\d*)$/u.test(key) ? Number(key) : -1;
      if (key !== 'length' && (!Number.isSafeInteger(index) || index < 0 || index >= value.assertions.length)) {
        errors.push(`$.assertions.${String(key)} is unknown`);
      }
    }
    for (let index = 0; index < value.assertions.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value.assertions, index)) {
        errors.push(`$.assertions[${index}] must not be sparse`);
      } else {
        validateNode(value.assertions[index], 'assertion', `$.assertions[${index}]`, errors, new Set(), new Set());
      }
    }
  }
  return { valid: errors.length === 0, errors };
}
