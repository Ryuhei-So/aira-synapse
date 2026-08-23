/**
 * Synapse-owned structural contract for bounded GraphDB domain objects.
 *
 * The domain interfaces remain the TypeScript source of truth for callers.
 * This module is the one runtime/fixture authority for the JSON shape that
 * crosses the bounded data-plane boundary.  The small contract DSL is
 * intentionally generic: field names are declared once, then the same
 * declaration drives compile-time witnesses, strict recursive validation, and
 * the deterministic fixture generator.
 */

import type { Fact } from './fact.js';
import type { Passage } from './passage.js';
import type { Schema } from './schema.js';

export const DOMAIN_CONTRACT_VERSION = 'aira-synapse-domain-contract@1' as const;

type Primitive = string | number | boolean;

interface StringContract {
  readonly kind: 'string';
}

interface NumberContract {
  readonly kind: 'number';
}

interface BooleanContract {
  readonly kind: 'boolean';
}

interface LiteralContract<Values extends readonly Primitive[]> {
  readonly kind: 'literal';
  readonly values: Values;
}

interface ArrayContract<Item extends ContractNode> {
  readonly kind: 'array';
  readonly items: Item;
}

interface OptionalContract<Value extends ContractNode> {
  readonly kind: 'optional';
  readonly value: Value;
}

type ContractFields = Readonly<Record<string, ContractNode>>;

interface ObjectContract<Fields extends ContractFields> {
  readonly kind: 'object';
  readonly fields: Fields;
}

export type ContractNode =
  | StringContract
  | NumberContract
  | BooleanContract
  | LiteralContract<readonly Primitive[]>
  | ArrayContract<ContractNode>
  | OptionalContract<ContractNode>
  | ObjectContract<ContractFields>;

function stringContract(): StringContract {
  return { kind: 'string' };
}

function numberContract(): NumberContract {
  return { kind: 'number' };
}

function booleanContract(): BooleanContract {
  return { kind: 'boolean' };
}

function literalContract<const Values extends readonly Primitive[]>(
  ...values: Values
): LiteralContract<Values> {
  return { kind: 'literal', values };
}

function arrayContract<const Item extends ContractNode>(
  items: Item,
): ArrayContract<Item> {
  return { kind: 'array', items };
}

function optionalContract<const Value extends ContractNode>(
  value: Value,
): OptionalContract<Value> {
  return { kind: 'optional', value };
}

function objectContract<const Fields extends ContractFields>(
  fields: Fields,
): ObjectContract<Fields> {
  return { kind: 'object', fields };
}

type OptionalKeys<Fields extends ContractFields> = {
  [Key in keyof Fields]-?: Fields[Key] extends OptionalContract<ContractNode>
    ? Key
    : never;
}[keyof Fields];

type RequiredKeys<Fields extends ContractFields> = Exclude<
  keyof Fields,
  OptionalKeys<Fields>
>;

type UnwrapOptional<Node extends ContractNode> = Node extends OptionalContract<infer Value>
  ? Value
  : Node;

type ContractValue<Node extends ContractNode> =
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
                : never;

/** A type-level witness that the contract and domain interface are equivalent at the boundary. */
type AssertAssignable<From extends To, To> = From;

const DOCUMENT_METADATA_CONTRACT = objectContract({
  documentId: stringContract(),
  title: stringContract(),
  sourceUrl: stringContract(),
  doi: optionalContract(stringContract()),
  sourceDb: optionalContract(stringContract()),
  sourceType: optionalContract(literalContract('pdf', 'html', 'docx', 'pptx', 'md')),
  language: literalContract('en', 'ja', 'mixed', 'unknown'),
  convertedAt: optionalContract(stringContract()),
  sectionPath: arrayContract(stringContract()),
  chunkId: stringContract(),
  chunkIndex: numberContract(),
  offsetStart: numberContract(),
  offsetEnd: numberContract(),
});

const SCHEMA_ALIAS_CONTRACT = objectContract({
  label: stringContract(),
  language: literalContract('en', 'ja', 'mixed', 'unknown'),
  source: literalContract('llm', 'nlp', 'dictionary', 'thesaurus', 'manual', 'import'),
  confidence: numberContract(),
  isCanonical: booleanContract(),
});

export const PASSAGE_CONTRACT = objectContract({
  corpusId: stringContract(),
  createdAt: stringContract(),
  updatedAt: stringContract(),
  passageId: stringContract(),
  text: stringContract(),
  normalizedText: stringContract(),
  metadata: DOCUMENT_METADATA_CONTRACT,
  factIds: arrayContract(stringContract()),
  entityMentions: arrayContract(stringContract()),
  qualityFlags: arrayContract(stringContract()),
  qualityScore: optionalContract(numberContract()),
});

export const FACT_CONTRACT = objectContract({
  corpusId: stringContract(),
  createdAt: stringContract(),
  updatedAt: stringContract(),
  factId: stringContract(),
  schemaId: stringContract(),
  headEntity: stringContract(),
  headType: stringContract(),
  relation: stringContract(),
  tailEntity: stringContract(),
  tailType: stringContract(),
  state: literalContract('active', 'inactive'),
  passageIds: arrayContract(stringContract()),
  sourceDocumentIds: arrayContract(stringContract()),
  confidence: numberContract(),
  temporalScope: optionalContract(stringContract()),
  granularityParentFactId: optionalContract(stringContract()),
});

export const SCHEMA_CONTRACT = objectContract({
  corpusId: stringContract(),
  createdAt: stringContract(),
  updatedAt: stringContract(),
  schemaId: stringContract(),
  headType: stringContract(),
  relation: stringContract(),
  tailType: stringContract(),
  canonicalKey: stringContract(),
  aliases: arrayContract(SCHEMA_ALIAS_CONTRACT),
  frequency: numberContract(),
  state: literalContract('pending', 'stable'),
  stabilizationThreshold: numberContract(),
  factIds: arrayContract(stringContract()),
  sourceDocumentIds: arrayContract(stringContract()),
  version: numberContract(),
});

/**
 * Both directions are deliberate: a missing contract field makes the domain
 * interface fail the second witness, while an invented contract field makes
 * the first witness fail. Optionality and nested shapes are checked too.
 */
type PassageContractMatchesDomain = [
  AssertAssignable<ContractValue<typeof PASSAGE_CONTRACT>, Passage>,
  AssertAssignable<Passage, ContractValue<typeof PASSAGE_CONTRACT>>,
];
type FactContractMatchesDomain = [
  AssertAssignable<ContractValue<typeof FACT_CONTRACT>, Fact>,
  AssertAssignable<Fact, ContractValue<typeof FACT_CONTRACT>>,
];
type SchemaContractMatchesDomain = [
  AssertAssignable<ContractValue<typeof SCHEMA_CONTRACT>, Schema>,
  AssertAssignable<Schema, ContractValue<typeof SCHEMA_CONTRACT>>,
];

// Keep these aliases referenced so noUnusedLocals catches a broken witness.
export type DomainContractTypeWitness =
  | PassageContractMatchesDomain
  | FactContractMatchesDomain
  | SchemaContractMatchesDomain;

export type DomainObjectKind = 'passage' | 'fact' | 'schema';
export type DomainObjectByKind<Kind extends DomainObjectKind> =
  Kind extends 'passage' ? Passage
    : Kind extends 'fact' ? Fact
      : Schema;

export const DOMAIN_CONTRACTS = {
  passage: PASSAGE_CONTRACT,
  fact: FACT_CONTRACT,
  schema: SCHEMA_CONTRACT,
} as const satisfies Readonly<Record<DomainObjectKind, ContractNode>>;

export interface DomainContractValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
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
      value.forEach((item, index) => validateNode(node.items, item, `${path}[${index}]`, errors));
      return;
    case 'optional':
      // Optional fields are handled by their containing object.  Keeping this
      // branch permissive also makes the generic validator composable.
      if (value !== undefined) validateNode(node.value, value, path, errors);
      return;
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        errors.push(`${path} must be an object`);
        return;
      }
      const fields = node.fields;
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string' || !hasOwn(fields, key)) {
          errors.push(`${path}.${displayKey(key)} is an unknown field`);
        }
      }
      for (const [key, child] of Object.entries(fields)) {
        if (!hasOwn(value, key)) {
          if (child.kind !== 'optional') errors.push(`${path}.${key} is required`);
          continue;
        }
        // A present optional key must still carry the declared value type;
        // accepting explicit undefined would create a shape not representable
        // by the JSON transport.
        validateNode(
          child.kind === 'optional' ? child.value : child,
          (value as Record<string, unknown>)[key],
          `${path}.${key}`,
          errors,
        );
      }
      return;
    }
  }
}

export function validateDomainObject<K extends DomainObjectKind>(
  kind: K,
  value: unknown,
): DomainContractValidation {
  const errors: string[] = [];
  validateNode(DOMAIN_CONTRACTS[kind], value, '$', errors);
  return { valid: errors.length === 0, errors };
}

export function isDomainObject<K extends DomainObjectKind>(
  kind: K,
  value: unknown,
): value is DomainObjectByKind<K> {
  return validateDomainObject(kind, value).valid;
}
