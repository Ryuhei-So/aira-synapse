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
import { DOCUMENT_SOURCE_TYPE_VALUES, type DocumentMetadata, type Passage } from './passage.js';
import type { Schema, SchemaAlias } from './schema.js';
import {
  FACT_STATE_VALUES,
  LANGUAGE_CODE_VALUES,
  PROVENANCE_SOURCE_VALUES,
  SCHEMA_STATE_VALUES,
  type LanguageCode,
} from './types.js';
import {
  arrayContract,
  booleanContract,
  literalContract,
  numberContract,
  objectContract,
  optionalContract,
  stringContract,
  validateContractNode,
  type ContractNode,
  type ContractValue,
} from '../contract/structural.js';

export type { ContractNode, ContractValue } from '../contract/structural.js';

export const DOMAIN_CONTRACT_VERSION = 'aira-synapse-domain-contract@1' as const;

/** A type-level witness that the contract and domain interface are equivalent at the boundary. */
type AssertAssignable<From extends To, To> = From;
type SameKeys<Left, Right> = keyof Left extends keyof Right
  ? keyof Right extends keyof Left ? true : false
  : false;
type SameType<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
  ? (<Value>() => Value extends Right ? 1 : 2) extends
    (<Value>() => Value extends Left ? 1 : 2) ? true : false
  : false;
type AssertTrue<Value extends true> = Value;
type AssertFalse<Value extends false> = Value;

const DOCUMENT_METADATA_CONTRACT = objectContract({
  documentId: stringContract(),
  title: stringContract(),
  sourceUrl: stringContract(),
  doi: optionalContract(stringContract()),
  sourceDb: optionalContract(stringContract()),
  sourceType: optionalContract(literalContract(...DOCUMENT_SOURCE_TYPE_VALUES)),
  language: literalContract(...LANGUAGE_CODE_VALUES),
  convertedAt: optionalContract(stringContract()),
  sectionPath: arrayContract(stringContract()),
  chunkId: stringContract(),
  chunkIndex: numberContract(),
  offsetStart: numberContract(),
  offsetEnd: numberContract(),
});

const SCHEMA_ALIAS_CONTRACT = objectContract({
  label: stringContract(),
  language: literalContract(...LANGUAGE_CODE_VALUES),
  source: literalContract(...PROVENANCE_SOURCE_VALUES),
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
  state: literalContract(...FACT_STATE_VALUES),
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
  state: literalContract(...SCHEMA_STATE_VALUES),
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

type DomainContractExactKeys = [
  AssertTrue<SameKeys<ContractValue<typeof PASSAGE_CONTRACT>, Passage>>,
  AssertTrue<SameKeys<ContractValue<typeof DOCUMENT_METADATA_CONTRACT>, DocumentMetadata>>,
  AssertTrue<SameKeys<ContractValue<typeof FACT_CONTRACT>, Fact>>,
  AssertTrue<SameKeys<ContractValue<typeof SCHEMA_CONTRACT>, Schema>>,
  AssertTrue<SameKeys<ContractValue<typeof SCHEMA_ALIAS_CONTRACT>, SchemaAlias>>,
];

// Compile-negative witnesses: optional/nested/enum drift must make exactness false.
type DomainContractRejectsDrift = [
  AssertFalse<SameKeys<ContractValue<typeof PASSAGE_CONTRACT>, Passage & { futureOptional?: string }>>,
  AssertFalse<SameKeys<ContractValue<typeof DOCUMENT_METADATA_CONTRACT>, DocumentMetadata & { futureNested?: string }>>,
  AssertFalse<SameType<ContractValue<typeof SCHEMA_ALIAS_CONTRACT>['language'], LanguageCode | 'future-language'>>,
];

// Keep these aliases referenced so noUnusedLocals catches a broken witness.
export type DomainContractTypeWitness =
  | PassageContractMatchesDomain
  | FactContractMatchesDomain
  | SchemaContractMatchesDomain
  | DomainContractExactKeys
  | DomainContractRejectsDrift;

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

/**
 * Complete machine-readable boundary authority.  The generated contract
 * artifact hashes this value independently from the example fixture, so a
 * field, optionality, nesting, or literal-set change cannot retain the old
 * cross-repository contract identity merely because the examples still fit.
 */
export const DOMAIN_CONTRACT_ARTIFACT = {
  contractVersion: DOMAIN_CONTRACT_VERSION,
  contracts: DOMAIN_CONTRACTS,
} as const;

export interface DomainContractValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
}


export function validateDomainObject<K extends DomainObjectKind>(
  kind: K,
  value: unknown,
): DomainContractValidation {
  return validateContractNode(DOMAIN_CONTRACTS[kind], value);
}

export function isDomainObject<K extends DomainObjectKind>(
  kind: K,
  value: unknown,
): value is DomainObjectByKind<K> {
  return validateDomainObject(kind, value).valid;
}
