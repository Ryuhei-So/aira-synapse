/**
 * Neutral structural-contract DSL used by Synapse-owned wire boundaries.
 *
 * This module deliberately knows nothing about memory objects or retrieval.
 * A declaration is both a type-level shape and a strict runtime JSON-shape
 * validator.  External references are resolved by the caller so a contract
 * can delegate to another pinned contract without copying its fields.
 */

export type StructuralPrimitive = string | number | boolean;

export interface StringContract {
  readonly kind: 'string';
}

export interface NumberContract {
  readonly kind: 'number';
}

export interface BooleanContract {
  readonly kind: 'boolean';
}

export interface LiteralContract<Values extends readonly StructuralPrimitive[] = readonly StructuralPrimitive[]> {
  readonly kind: 'literal';
  readonly values: Values;
}

export interface ArrayContract<Item extends ContractNode = ContractNode> {
  readonly kind: 'array';
  readonly items: Item;
}

export interface OptionalContract<Value extends ContractNode = ContractNode> {
  readonly kind: 'optional';
  readonly value: Value;
}

export type ContractFields = Readonly<Record<string, ContractNode>>;

export interface ObjectContract<Fields extends ContractFields = ContractFields> {
  readonly kind: 'object';
  readonly fields: Fields;
}

export interface DiscriminatedUnionContract<
  Discriminator extends string = string,
  Branches extends Readonly<Record<string, ObjectContract>> = Readonly<Record<string, ObjectContract>>,
> {
  readonly kind: 'discriminatedUnion';
  readonly discriminator: Discriminator;
  readonly branches: Branches;
}

/**
 * Value is carried as a type parameter because a neutral contract utility
 * cannot import every domain type that may be referenced by an artifact.
 */
export interface ExternalReferenceContract<
  ReferenceKind extends string = string,
  Value = unknown,
> {
  readonly kind: 'externalRef';
  readonly referenceKind: ReferenceKind;
  readonly dependency: string;
  /** Type-only witness; no value is emitted into the wire declaration. */
  readonly __value?: Value;
}

export type ContractNode =
  | StringContract
  | NumberContract
  | BooleanContract
  | LiteralContract
  | ArrayContract
  | OptionalContract
  | ObjectContract
  | DiscriminatedUnionContract
  | ExternalReferenceContract;

export function stringContract(): StringContract {
  return { kind: 'string' };
}

export function numberContract(): NumberContract {
  return { kind: 'number' };
}

export function booleanContract(): BooleanContract {
  return { kind: 'boolean' };
}

export function literalContract<const Values extends readonly StructuralPrimitive[]>(
  ...values: Values
): LiteralContract<Values> {
  return { kind: 'literal', values };
}

export function arrayContract<const Item extends ContractNode>(
  items: Item,
): ArrayContract<Item> {
  return { kind: 'array', items };
}

export function optionalContract<const Value extends ContractNode>(
  value: Value,
): OptionalContract<Value> {
  return { kind: 'optional', value };
}

export function objectContract<const Fields extends ContractFields>(
  fields: Fields,
): ObjectContract<Fields> {
  return { kind: 'object', fields };
}

export function discriminatedUnionContract<
  const Discriminator extends string,
  const Branches extends Readonly<Record<string, ObjectContract>>,
>(
  discriminator: Discriminator,
  branches: Branches,
): DiscriminatedUnionContract<Discriminator, Branches> {
  return { kind: 'discriminatedUnion', discriminator, branches };
}

export function externalRefContract<
  const ReferenceKind extends string,
  Value = unknown,
>(
  referenceKind: ReferenceKind,
  dependency: string,
): ExternalReferenceContract<ReferenceKind, Value> {
  return { kind: 'externalRef', referenceKind, dependency };
}

/** More explicit alias for callers defining cross-contract references. */
export const externalReferenceContract = externalRefContract;

type OptionalKeys<Fields extends ContractFields> = {
  [Key in keyof Fields]-?: Fields[Key] extends OptionalContract ? Key : never;
}[keyof Fields];

type RequiredKeys<Fields extends ContractFields> = Exclude<keyof Fields, OptionalKeys<Fields>>;

type UnwrapOptional<Node extends ContractNode> = Node extends OptionalContract<infer Value>
  ? Value
  : Node;

/** Type inferred from a structural declaration. */
export type ContractValue<Node extends ContractNode> =
  Node extends StringContract ? string
    : Node extends NumberContract ? number
      : Node extends BooleanContract ? boolean
        : Node extends LiteralContract<infer Values> ? Values[number]
          : Node extends ArrayContract<infer Item> ? readonly ContractValue<Item>[]
            : Node extends OptionalContract<infer Value> ? ContractValue<Value> | undefined
              : Node extends ObjectContract<infer Fields>
                ? {
                  readonly [Key in RequiredKeys<Fields>]: ContractValue<Fields[Key]>;
                } & {
                  readonly [Key in OptionalKeys<Fields>]?: ContractValue<UnwrapOptional<Fields[Key]>>;
                }
                : Node extends DiscriminatedUnionContract<string, infer Branches>
                  ? ContractValue<Branches[keyof Branches]>
                  : Node extends ExternalReferenceContract<string, infer Value> ? Value
                    : never;

export type ExternalReferenceResolver = (
  reference: ExternalReferenceContract,
  value: unknown,
  path: string,
  errors: string[],
) => void;

export interface ContractValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function displayKey(key: PropertyKey): string {
  return typeof key === 'symbol' ? key.toString() : String(key);
}

function validateNode(
  node: ContractNode,
  value: unknown,
  path: string,
  errors: string[],
  externalReferenceResolver?: ExternalReferenceResolver,
): void {
  switch (node.kind) {
    case 'string':
      if (typeof value !== 'string') errors.push(`${path} must be a string`);
      return;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`${path} must be a finite number`);
      }
      return;
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(`${path} must be a boolean`);
      return;
    case 'literal':
      if (!node.values.some((candidate) => Object.is(candidate, value))) {
        errors.push(`${path} must be one of ${node.values.map(String).join(', ')}`);
      }
      return;
    case 'array':
      if (!Array.isArray(value)) {
        errors.push(`${path} must be an array`);
        return;
      }
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        errors.push(`${path} must use the plain Array prototype`);
      }
      for (const key of Reflect.ownKeys(value)) {
        const numericKey = typeof key === 'string' && /^(0|[1-9]\d*)$/u.test(key)
          ? Number(key)
          : Number.NaN;
        const isPresentIndex = Number.isSafeInteger(numericKey)
          && numericKey >= 0
          && numericKey < value.length;
        if (key !== 'length' && !isPresentIndex) {
          errors.push(`${path}.${displayKey(key)} is an unknown array field`);
        }
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!hasOwn(value, String(index))) errors.push(`${path}[${index}] must not be sparse`);
      }
      value.forEach((item, index) => validateNode(
        node.items,
        item,
        `${path}[${index}]`,
        errors,
        externalReferenceResolver,
      ));
      return;
    case 'optional':
      // Optional is normally handled by an object.  A present optional value
      // is still validated; explicit undefined is not a JSON value.
      if (value !== undefined) validateNode(node.value, value, path, errors, externalReferenceResolver);
      return;
    case 'object':
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        errors.push(`${path} must be an object`);
        return;
      }
      if (!isPlainRecord(value)) {
        errors.push(`${path} must use a plain or null prototype`);
      }
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string' || !hasOwn(node.fields, key)) {
          errors.push(`${path}.${displayKey(key)} is an unknown field`);
        }
      }
      for (const [key, child] of Object.entries(node.fields)) {
        if (!hasOwn(value, key)) {
          if (child.kind !== 'optional') errors.push(`${path}.${key} is required`);
          continue;
        }
        validateNode(
          child.kind === 'optional' ? child.value : child,
          (value as Record<string, unknown>)[key],
          `${path}.${key}`,
          errors,
          externalReferenceResolver,
        );
      }
      return;
    case 'discriminatedUnion': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        errors.push(`${path} must be an object for discriminated union ${node.discriminator}`);
        return;
      }
      if (!isPlainRecord(value)) errors.push(`${path} must use a plain or null prototype`);
      if (!hasOwn(value, node.discriminator)) {
        errors.push(`${path}.${node.discriminator} is required to select a branch`);
        return;
      }
      const tag = (value as Record<string, unknown>)[node.discriminator];
      const matches = Object.entries(node.branches).filter(([, branch]) => {
        const discriminator = branch.fields[node.discriminator];
        return discriminator?.kind === 'literal'
          && discriminator.values.some((candidate) => Object.is(candidate, tag));
      });
      if (matches.length === 0) {
        errors.push(`${path}.${node.discriminator} has an unknown tag`);
        return;
      }
      if (matches.length !== 1) {
        errors.push(`${path}.${node.discriminator} selects an ambiguous branch`);
        return;
      }
      validateNode(matches[0]![1], value, path, errors, externalReferenceResolver);
      return;
    }
    case 'externalRef':
      if (!externalReferenceResolver) {
        errors.push(`${path} external reference ${node.referenceKind} has no resolver`);
        return;
      }
      externalReferenceResolver(node, value, path, errors);
      return;
  }
}

/** Validate a value without weakening unknown-key or JSON-boundary checks. */
export function validateContractNode(
  node: ContractNode,
  value: unknown,
  externalReferenceResolver?: ExternalReferenceResolver,
): ContractValidation {
  const errors: string[] = [];
  try {
    validateNode(node, value, '$', errors, externalReferenceResolver);
  } catch (error) {
    errors.push(`$ validation failed closed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { valid: errors.length === 0, errors };
}

function declarationError(errors: string[], path: string, message: string): void {
  errors.push(`${path} ${message}`);
}

function validateDeclarationNode(node: unknown, path: string, errors: string[]): void {
  if (!isPlainRecord(node)) {
    declarationError(errors, path, 'must be a plain object');
    return;
  }
  const kind = node.kind;
  if (typeof kind !== 'string') {
    declarationError(errors, path, 'kind must be a string');
    return;
  }
  const exactDeclarationKeys = (expected: readonly string[]): void => {
    const allowed = new Set(expected);
    for (const key of Reflect.ownKeys(node)) {
      if (typeof key !== 'string' || !allowed.has(key)) declarationError(errors, path, `has unknown field ${displayKey(key)}`);
    }
    for (const key of expected) {
      if (!hasOwn(node, key)) declarationError(errors, path, `is missing ${key}`);
    }
  };
  switch (kind) {
    case 'string':
      exactDeclarationKeys(['kind']);
      return;
    case 'number':
      exactDeclarationKeys(['kind']);
      return;
    case 'boolean':
      exactDeclarationKeys(['kind']);
      return;
    case 'literal': {
      exactDeclarationKeys(['kind', 'values']);
      if (!Array.isArray(node.values) || node.values.length === 0) {
        declarationError(errors, path, 'values must be a non-empty array');
      } else {
        for (const [index, value] of node.values.entries()) {
          if ((typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean')
            || (typeof value === 'number' && !Number.isFinite(value))) {
            declarationError(errors, `${path}.values[${index}]`, 'must be a finite primitive');
          }
        }
      }
      return;
    }
    case 'array':
      exactDeclarationKeys(['kind', 'items']);
      validateDeclarationNode(node.items, `${path}.items`, errors);
      return;
    case 'optional':
      exactDeclarationKeys(['kind', 'value']);
      validateDeclarationNode(node.value, `${path}.value`, errors);
      return;
    case 'object':
      exactDeclarationKeys(['kind', 'fields']);
      if (!isPlainRecord(node.fields)) {
        declarationError(errors, `${path}.fields`, 'must be a plain object');
      } else {
        for (const [key, child] of Object.entries(node.fields)) {
          if (key.length === 0) declarationError(errors, `${path}.fields`, 'cannot contain an empty field name');
          validateDeclarationNode(child, `${path}.fields.${key}`, errors);
        }
      }
      return;
    case 'discriminatedUnion': {
      exactDeclarationKeys(['kind', 'discriminator', 'branches']);
      if (typeof node.discriminator !== 'string' || node.discriminator.length === 0) {
        declarationError(errors, `${path}.discriminator`, 'must be a non-empty string');
      }
      if (!isPlainRecord(node.branches) || Object.keys(node.branches).length === 0) {
        declarationError(errors, `${path}.branches`, 'must be a non-empty plain object');
        return;
      }
      const tags = new Set<StructuralPrimitive>();
      for (const [branchName, branch] of Object.entries(node.branches)) {
        if (!isPlainRecord(branch) || branch.kind !== 'object') {
          declarationError(errors, `${path}.branches.${branchName}`, 'must be an object contract');
          validateDeclarationNode(branch, `${path}.branches.${branchName}`, errors);
          continue;
        }
        validateDeclarationNode(branch, `${path}.branches.${branchName}`, errors);
        const discriminatorName = node.discriminator;
        const discriminator = typeof discriminatorName === 'string' && isPlainRecord(branch.fields)
          ? branch.fields[discriminatorName]
          : undefined;
        if (!isPlainRecord(discriminator) || discriminator.kind !== 'literal'
          || !Array.isArray(discriminator.values)
          || discriminator.values.length !== 1
          || discriminator.values[0] !== branchName) {
          declarationError(
            errors,
            `${path}.branches.${branchName}`,
            `must require literal ${node.discriminator}=${branchName}`,
          );
        } else if (tags.has(discriminator.values[0])) {
          declarationError(errors, `${path}.branches.${branchName}`, 'has an ambiguous discriminator tag');
        } else {
          tags.add(discriminator.values[0]);
        }
      }
      return;
    }
    case 'externalRef':
      exactDeclarationKeys(['kind', 'referenceKind', 'dependency']);
      if (typeof node.referenceKind !== 'string' || node.referenceKind.length === 0) {
        declarationError(errors, `${path}.referenceKind`, 'must be a non-empty string');
      }
      if (typeof node.dependency !== 'string' || node.dependency.length === 0) {
        declarationError(errors, `${path}.dependency`, 'must be a non-empty string');
      }
      return;
    default:
      declarationError(errors, path, `uses unknown contract node ${String(kind)}`);
  }
}

/** Validate a parsed declaration before it is allowed to drive an interpreter. */
export function validateContractDeclaration(node: unknown): ContractValidation {
  const errors: string[] = [];
  try {
    validateDeclarationNode(node, '$', errors);
  } catch (error) {
    errors.push(`$ declaration validation failed closed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { valid: errors.length === 0, errors };
}

export class ContractDeclarationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ContractDeclarationError';
  }
}

export function assertContractDeclaration(node: unknown): asserts node is ContractNode {
  const validation = validateContractDeclaration(node);
  if (!validation.valid) throw new ContractDeclarationError(validation.errors.join('; '));
}

/** Canonical JSON used by both generated artifacts and semantic digests. */
export function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new TypeError('canonical JSON requires plain arrays');
    }
    for (const key of Reflect.ownKeys(value)) {
      const numericKey = typeof key === 'string' && /^(0|[1-9]\d*)$/u.test(key)
        ? Number(key)
        : Number.NaN;
      const isPresentIndex = Number.isSafeInteger(numericKey)
        && numericKey >= 0
        && numericKey < value.length;
      if (key !== 'length' && !isPresentIndex) {
        throw new TypeError(`canonical JSON rejects array field ${displayKey(key)}`);
      }
    }
    return Array.from({ length: value.length }, (_, index) => {
      if (!hasOwn(value, String(index))) {
        throw new TypeError(`canonical JSON rejects sparse array index ${index}`);
      }
      return canonicalizeJson(value[index]);
    });
  }
  if (value !== null && typeof value === 'object') {
    if (!isPlainRecord(value)) throw new TypeError('canonical JSON requires plain objects');
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        throw new TypeError(`canonical JSON rejects object field ${displayKey(key)}`);
      }
    }
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalizeJson(value[key])]),
    );
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError('canonical JSON rejects non-finite numbers');
  }
  if (value === undefined
    || typeof value === 'bigint'
    || typeof value === 'function'
    || typeof value === 'symbol') {
    throw new TypeError(`canonical JSON rejects ${typeof value}`);
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  const encoded = JSON.stringify(canonicalizeJson(value), null, 2);
  if (encoded === undefined) throw new TypeError('canonical JSON has no representation');
  return `${encoded}\n`;
}
