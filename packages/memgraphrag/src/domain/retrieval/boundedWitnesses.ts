/**
 * Producer-owned negative witnesses for the bounded retrieval artifact.
 *
 * The refinement programs remain the semantic authority.  The patch recipes
 * below only choose one JSON replacement for each declared assertion; every
 * recipe is checked against the canonical evaluator before it can become an
 * artifact.  Consumers validate and execute the resulting closed patches,
 * but never need a second mutation catalog.
 */
import { canonicalJson } from '../contract/structural.js';
import { DOMAIN_CONTRACTS } from '../memory/domainContract.js';
import {
  BOUNDED_RETRIEVAL_OPERATION_NAMES,
  BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS,
  validateBoundedSemanticExchange,
  validateBoundedSemanticExchangeShape,
  validateBoundedSemanticRequest,
  type BoundedSemanticDeclaration,
  type BoundedRetrievalOperationName,
} from './boundedContract.js';
import {
  inspectRefinementProgram,
  type RefinementEvaluationContext,
  type RefinementEvaluationFailure,
} from './refinementEvaluator.js';
import type { RefinementProgram } from './refinementIr.js';
import { normalizeV15Entity, V15_ENTITY_NORMALIZATION_DIGEST } from './v15Plan.js';

export const BOUNDED_RETRIEVAL_FIXTURE_VERSION =
  'aira-synapse-bounded-retrieval-fixture@2' as const;
export const BOUNDED_RETRIEVAL_WITNESS_VERSION =
  'aira-synapse-bounded-retrieval-witness@1' as const;
export const BOUNDED_RETRIEVAL_PUBLICATION_BUDGET_BYTES = 96 * 1024;

/** Enforce Synapse's publication budget before a fixture can be published. */
export function assertBoundedRetrievalPublicationBudget(fixtureText: string): void {
  const fixtureBytes = Buffer.byteLength(fixtureText, 'utf8');
  if (fixtureBytes > BOUNDED_RETRIEVAL_PUBLICATION_BUDGET_BYTES) {
    throw new RangeError(
      `bounded retrieval fixture exceeds the 96 KiB producer publication budget: ${fixtureBytes} > ${BOUNDED_RETRIEVAL_PUBLICATION_BUDGET_BYTES} bytes`,
    );
  }
}

export type BoundedAssertionPartition = 'request' | 'exchange';
export type BoundedReplacementRoot = 'request' | 'result';

export type BoundedJsonValue =
  | null
  | string
  | number
  | boolean
  | { readonly [key: string]: BoundedJsonValue }
  | readonly BoundedJsonValue[];

export interface BoundedReplacementPatch {
  readonly root: BoundedReplacementRoot;
  /** RFC 6901 pointer relative to root; the pointed value must already exist. */
  readonly path: string;
  readonly value: BoundedJsonValue;
}

export interface BoundedAssertionIdentity {
  readonly operation: BoundedRetrievalOperationName;
  readonly partition: BoundedAssertionPartition;
  readonly assertionIndex: number;
}

export interface BoundedAssertionWitness extends BoundedAssertionIdentity {
  readonly patch: BoundedReplacementPatch;
}

export interface BoundedSemanticExchangeFixture {
  readonly request: BoundedJsonValue;
  readonly result: BoundedJsonValue;
}

export interface BoundedRetrievalFixture {
  readonly fixtureVersion: typeof BOUNDED_RETRIEVAL_FIXTURE_VERSION;
  readonly witnessVersion: typeof BOUNDED_RETRIEVAL_WITNESS_VERSION;
  readonly exchanges: Readonly<Record<BoundedRetrievalOperationName, BoundedSemanticExchangeFixture>>;
  readonly witnesses: readonly BoundedAssertionWitness[];
}

export interface BoundedAssertionPartitionCoverage {
  readonly request: number;
  readonly exchange: number;
}

export interface BoundedAssertionCoverage {
  readonly byOperation: Readonly<Record<BoundedRetrievalOperationName, BoundedAssertionPartitionCoverage>>;
  readonly identities: readonly BoundedAssertionIdentity[];
}

type BoundedProgramSet = Readonly<Record<BoundedRetrievalOperationName, BoundedSemanticDeclaration>>;
type JsonRecord = { [key: string]: BoundedJsonValue };
type JsonArray = BoundedJsonValue[];
type PatchGroups = {
  readonly request: readonly BoundedReplacementPatch[];
  readonly exchange: readonly BoundedReplacementPatch[];
};
type PatchBuilder = (exchange: BoundedSemanticExchangeFixture) => PatchGroups;

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function asRecord(value: unknown, name: string): JsonRecord {
  if (!isPlainRecord(value)) throw new TypeError(`${name} must be a plain object`);
  return value as JsonRecord;
}

function asArray(value: unknown, name: string): JsonArray {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  return value as JsonArray;
}

function asString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
  return value;
}

function asNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${name} must be a finite number`);
  return value;
}

function canonicalSegments(path: string): string[] {
  if (path === '') return [];
  if (!path.startsWith('/') || path.slice(1).split('/').some((segment) => /~(?![01])/u.test(segment))) {
    throw new TypeError(`path ${path} is not a canonical JSON Pointer`);
  }
  return path.slice(1).split('/').map((segment) => segment.replace(/~1/gu, '/').replace(/~0/gu, '~'));
}

function arrayIndex(segment: string, length: number): number {
  if (!/^(0|[1-9]\d*)$/u.test(segment)) throw new TypeError(`array pointer segment ${segment} is not an existing index`);
  const index = Number(segment);
  if (!Number.isSafeInteger(index) || index < 0 || index >= length) {
    throw new TypeError(`array pointer index ${segment} is out of range`);
  }
  return index;
}

function readPointer(root: BoundedJsonValue, path: string): BoundedJsonValue {
  let current = root;
  for (const segment of canonicalSegments(path)) {
    if (Array.isArray(current)) {
      current = current[arrayIndex(segment, current.length)]!;
    } else if (isPlainRecord(current) && hasOwn(current, segment)) {
      current = current[segment] as BoundedJsonValue;
    } else {
      throw new TypeError(`pointer ${path} does not address an existing value`);
    }
  }
  return current;
}

function replaceAtPointer(
  current: BoundedJsonValue,
  segments: readonly string[],
  replacement: BoundedJsonValue,
  path: string,
): BoundedJsonValue {
  if (segments.length === 0) return replacement;
  const [segment, ...rest] = segments;
  if (Array.isArray(current)) {
    const index = arrayIndex(segment!, current.length);
    const copy = [...current];
    copy[index] = replaceAtPointer(current[index]!, rest, replacement, path);
    return copy;
  }
  if (isPlainRecord(current) && hasOwn(current, segment!)) {
    return {
      ...current,
      [segment!]: replaceAtPointer(current[segment!] as BoundedJsonValue, rest, replacement, path),
    };
  }
  throw new TypeError(`pointer ${path} does not address an existing value`);
}

function cloneJsonValue(value: BoundedJsonValue): BoundedJsonValue {
  return JSON.parse(canonicalJson(value)) as BoundedJsonValue;
}

/** Validate a patch independently of any selected exchange. */
export function validateBoundedReplacementPatch(
  value: unknown,
  path = '$',
): { valid: boolean; errors: readonly string[] } {
  const errors: string[] = [];
  if (!isPlainRecord(value)) return { valid: false, errors: [`${path} must be a plain object`] };
  const expected = new Set(['root', 'path', 'value']);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !expected.has(key)) errors.push(`${path}.${String(key)} is unknown`);
  }
  for (const key of expected) {
    if (!hasOwn(value, key)) errors.push(`${path}.${key} is required`);
  }
  if (hasOwn(value, 'root') && value.root !== 'request' && value.root !== 'result') {
    errors.push(`${path}.root must be request or result`);
  }
  if (hasOwn(value, 'path')) {
    if (typeof value.path !== 'string') errors.push(`${path}.path must be a canonical JSON Pointer`);
    else {
      try { canonicalSegments(value.path); } catch (error) {
        errors.push(`${path}.path ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (hasOwn(value, 'value')) validateJsonValue(value.value, `${path}.value`, errors, new Set());
  return { valid: errors.length === 0, errors };
}

function validateJsonValue(
  value: unknown,
  path: string,
  errors: string[],
  ancestors: Set<object>,
): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) errors.push(`${path} must be a finite number`);
    return;
  }
  if (typeof value !== 'object') {
    errors.push(`${path} must be a JSON value`);
    return;
  }
  if (ancestors.has(value)) {
    errors.push(`${path} must not contain a cycle`);
    return;
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) errors.push(`${path} must use the plain Array prototype`);
      for (const key of Reflect.ownKeys(value)) {
        const index = typeof key === 'string' && /^(0|[1-9]\d*)$/u.test(key) ? Number(key) : Number.NaN;
        if (key !== 'length' && (!Number.isSafeInteger(index) || index < 0 || index >= value.length)) {
          errors.push(`${path}.${String(key)} is unknown`);
        }
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!hasOwn(value, String(index))) errors.push(`${path}[${index}] must not be sparse`);
        else validateJsonValue(value[index], `${path}[${index}]`, errors, ancestors);
      }
      return;
    }
    if (!isPlainRecord(value)) {
      errors.push(`${path} must use a plain or null prototype`);
      return;
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') errors.push(`${path}.${String(key)} is unknown`);
      else validateJsonValue(value[key], `${path}.${key}`, errors, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

/** Apply one closed replacement without mutating either input or patch. */
export function applyBoundedReplacementPatch(
  exchange: BoundedSemanticExchangeFixture,
  patch: BoundedReplacementPatch,
): BoundedSemanticExchangeFixture {
  const validation = validateBoundedReplacementPatch(patch);
  if (!validation.valid) throw new TypeError(`bounded replacement patch failed closed: ${validation.errors.join('; ')}`);
  const root = patch.root === 'request' ? exchange.request : exchange.result;
  const replaced = replaceAtPointer(
    root,
    canonicalSegments(patch.path),
    cloneJsonValue(patch.value),
    patch.path,
  );
  return patch.root === 'request'
    ? { request: replaced, result: exchange.result }
    : { request: exchange.request, result: replaced };
}

export function boundedAssertionIdentity(
  operation: BoundedRetrievalOperationName,
  partition: BoundedAssertionPartition,
  assertionIndex: number,
): string {
  return `${operation}/${partition}/${assertionIndex}`;
}

function identityKey(identity: BoundedAssertionIdentity): string {
  return boundedAssertionIdentity(identity.operation, identity.partition, identity.assertionIndex);
}

function assertCanonicalProgramKeys(programs: BoundedProgramSet): void {
  const actual = Reflect.ownKeys(programs);
  if (actual.some((key) => typeof key !== 'string')
    || actual.join('\0') !== BOUNDED_RETRIEVAL_OPERATION_NAMES.join('\0')) {
    throw new Error('bounded retrieval programs must use the canonical operation set and order');
  }
}

/** Derive witness identities and counts directly from the canonical programs. */
export function deriveBoundedAssertionCoverage(
  programs: BoundedProgramSet = BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS,
): BoundedAssertionCoverage {
  assertCanonicalProgramKeys(programs);
  const byOperation = {} as Record<BoundedRetrievalOperationName, BoundedAssertionPartitionCoverage>;
  const identities: BoundedAssertionIdentity[] = [];
  for (const operation of BOUNDED_RETRIEVAL_OPERATION_NAMES) {
    const declaration = programs[operation];
    const program = declaration?.refinement;
    if (!program || !Array.isArray(program.requestAssertions) || !Array.isArray(program.exchangeAssertions)) {
      throw new Error(`${operation} does not provide complete refinement assertion arrays`);
    }
    byOperation[operation] = {
      request: program.requestAssertions.length,
      exchange: program.exchangeAssertions.length,
    };
    for (const partition of ['request', 'exchange'] as const) {
      const count = partition === 'request'
        ? program.requestAssertions.length
        : program.exchangeAssertions.length;
      for (let assertionIndex = 0; assertionIndex < count; assertionIndex += 1) {
        identities.push({ operation, partition, assertionIndex });
      }
    }
  }
  return { byOperation, identities };
}

function contextFor(exchange: BoundedSemanticExchangeFixture): RefinementEvaluationContext {
  return {
    request: exchange.request,
    result: exchange.result,
    normalize: (dependency, value) => {
      if (dependency !== V15_ENTITY_NORMALIZATION_DIGEST) throw new TypeError(`unknown normalization dependency ${dependency}`);
      return normalizeV15Entity(value);
    },
  };
}

function rootsFor(operation: BoundedRetrievalOperationName) {
  const declaration = BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS[operation];
  return {
    request: declaration.request,
    result: declaration.result,
    resolveExternal: (reference: { readonly referenceKind: string }) =>
      DOMAIN_CONTRACTS[reference.referenceKind as keyof typeof DOMAIN_CONTRACTS],
  };
}

function partialProgram(
  program: RefinementProgram,
  partition: BoundedAssertionPartition,
  assertionIndex: number,
): RefinementProgram {
  return {
    version: program.version,
    requestAssertions: partition === 'request'
      ? program.requestAssertions.slice(0, assertionIndex + 1)
      : program.requestAssertions,
    exchangeAssertions: partition === 'exchange'
      ? program.exchangeAssertions.slice(0, assertionIndex + 1)
      : [],
  };
}

function formatFailure(failure: RefinementEvaluationFailure | undefined): string {
  if (!failure) return 'no failure was observed';
  return `${failure.partition}[${failure.assertionIndex}] ${failure.opcode ?? 'unknown'} ${failure.kind}: ${failure.message}`;
}

function assertWitnessEvidence(
  identity: BoundedAssertionIdentity,
  exchange: BoundedSemanticExchangeFixture,
  patch: BoundedReplacementPatch,
  program: RefinementProgram,
): void {
  const shape = validateBoundedSemanticExchangeShape(identity.operation, exchange.request, exchange.result);
  if (!shape.valid) throw new Error(`${identityKey(identity)} baseline shape is invalid: ${shape.errors.join('; ')}`);
  const mutated = applyBoundedReplacementPatch(exchange, patch);
  const mutatedShape = validateBoundedSemanticExchangeShape(identity.operation, mutated.request, mutated.result);
  if (!mutatedShape.valid) {
    throw new Error(`${identityKey(identity)} is schema-only: ${mutatedShape.errors.join('; ')}`);
  }

  const observed = inspectRefinementProgram(
    partialProgram(program, identity.partition, identity.assertionIndex),
    contextFor(mutated),
    rootsFor(identity.operation),
  );
  const failure = observed.failure;
  if (observed.valid
    || failure?.partition !== identity.partition
    || failure.assertionIndex !== identity.assertionIndex
    || failure.kind !== 'false') {
    throw new Error(`${identityKey(identity)} does not fail at its addressed assertion: ${formatFailure(failure)}`);
  }

  if (identity.partition === 'request') {
    const requestValidation = validateBoundedSemanticRequest(identity.operation, mutated.request);
    if (requestValidation.valid) throw new Error(`${identityKey(identity)} request validation unexpectedly passed`);
  } else {
    const requestValidation = validateBoundedSemanticRequest(identity.operation, mutated.request);
    if (!requestValidation.valid) {
      throw new Error(`${identityKey(identity)} exchange patch invalidated request evaluation: ${requestValidation.errors.join('; ')}`);
    }
    const exchangeValidation = validateBoundedSemanticExchange(identity.operation, mutated.request, mutated.result);
    if (exchangeValidation.valid) throw new Error(`${identityKey(identity)} full exchange validation unexpectedly passed`);
  }
}

function candidateIdentityValue(kind: 'passage' | 'fact' | 'schema'): string {
  return kind === 'fact' ? 'fact:0' : `${kind}:wrong`;
}

function candidatePatches(exchange: BoundedSemanticExchangeFixture): PatchGroups {
  const result = exchange.result;
  const slots = [
    ['passage', 0, 'passageId'],
    ['fact', 1, 'factId'],
    ['schema', 2, 'schemaId'],
  ] as const;
  const requestPatches: BoundedReplacementPatch[] = [patch('request', '/corpusId', '')];
  const exchangePatches: BoundedReplacementPatch[] = [];
  for (const [kind, index, identityField] of slots) {
    const slot = `/slots/${index}`;
    const hitsPath = `${slot}/hits`;
    const hits = asArray(readPointer(result, hitsPath), `${hitsPath}`);
    const firstHit = asRecord(hits[0], `${hitsPath}/0`);
    const secondBaselineHit = asRecord(hits[1], `${hitsPath}/1`);
    const firstItem = asRecord(firstHit.item, `${hitsPath}/0/item`);
    const thirdHit = {
      ...firstHit,
      id: `${kind}:fixture-${kind}-3`,
      item: { ...firstItem, [identityField]: `fixture-${kind}-3` },
      score: -0.5,
    };
    const firstScore = asNumber(firstHit.score, `${hitsPath}/0/score`);
    requestPatches.push(
      patch('request', `${slot}/queryVector`, []),
      patch('request', `${slot}/threshold`, 2),
      patch('request', `${slot}/limit`, 0),
    );
    exchangePatches.push(
      patch('result', hitsPath, [firstHit, secondBaselineHit, thirdHit]),
      patch('result', hitsPath, [firstHit, { ...firstHit, score: firstScore - 0.1 }]),
      patch('result', hitsPath, [
        { ...firstHit, score: 0.5 },
        { ...secondBaselineHit, score: 0.75 },
      ]),
      patch('result', `${hitsPath}/0/id`, candidateIdentityValue(kind)),
      patch('result', `${hitsPath}/0/item/corpusId`, 'other-corpus'),
      patch('request', `${slot}/threshold`, kind === 'schema' ? 1 : 0),
      patch('result', `${hitsPath}/0/score`, 2),
    );
  }
  return { request: requestPatches, exchange: exchangePatches };
}

function factPatches(exchange: BoundedSemanticExchangeFixture): PatchGroups {
  const result = exchange.result;
  const first = asRecord(readPointer(result, '/facts/0'), 'result.facts[0]');
  const second = asRecord(readPointer(result, '/facts/1'), 'result.facts[1]');
  const firstFact = asRecord(first.fact, 'result.facts[0].fact');
  const uniqueTwin = {
    ...first,
    fact: {
      ...firstFact,
      headEntity: 'Beta',
      tailEntity: 'Gamma',
    },
    score: 0.15,
  };
  const third = {
    ...second,
    factId: 'f3',
    fact: {
      ...asRecord(second.fact, 'result.facts[1].fact'),
      factId: 'f3',
    },
  };
  const requestPatches: BoundedReplacementPatch[] = [
    patch('request', '/corpusId', ''),
    patch('request', '/plan/seedEntities/1/key', 'alpha'),
    patch('request', '/plan/seedEntities/0/key', ''),
    patch('request', '/plan/excludedSeedFactIds', ['']),
    patch('request', '/plan/seedEntities/0/score', -1),
    patch('request', '/plan/attenuation', -1),
    patch('request', '/plan/limit', 0),
    patch('request', '/plan/normalizationContractDigest', 'wrong'),
  ];
  const exchangePatches: BoundedReplacementPatch[] = [
    patch('result', '/facts', [first, second, third]),
    patch('result', '/facts', [first, uniqueTwin]),
    patch('result', '/facts', [second, first]),
    patch('result', '/facts/0/factId', '0'),
    patch('result', '/facts/0/fact/corpusId', 'other-corpus'),
    patch('request', '/plan/excludedSeedFactIds', [asString(first.factId, 'result.facts[0].factId')]),
    patch('request', '/plan/seedEntities', [
      { key: 'gamma', score: 1 },
      { key: 'delta', score: 0.5 },
    ]),
    patch('result', '/facts/0/score', 0.4),
  ];
  return { request: requestPatches, exchange: exchangePatches };
}

function pprPatches(exchange: BoundedSemanticExchangeFixture): PatchGroups {
  const result = exchange.result;
  const firstPassage = asRecord(readPointer(result, '/rankedPassages/0'), 'result.rankedPassages[0]');
  const secondPassage = asRecord(readPointer(result, '/rankedPassages/1'), 'result.rankedPassages[1]');
  const firstFact = asRecord(readPointer(result, '/rankedFacts/0'), 'result.rankedFacts[0]');
  const secondFact = asRecord(readPointer(result, '/rankedFacts/1'), 'result.rankedFacts[1]');
  const firstFactItem = asRecord(firstFact.fact, 'result.rankedFacts[0].fact');
  const duplicateFact = {
    ...secondFact,
    nodeId: asString(firstFact.nodeId, 'result.rankedFacts[0].nodeId'),
    score: 0.4,
    fact: {
      ...asRecord(secondFact.fact, 'result.rankedFacts[1].fact'),
      factId: asString(firstFactItem.factId, 'result.rankedFacts[0].fact.factId'),
    },
  };
  const thirdPassage = {
    ...secondPassage,
    nodeId: 'passage:p3',
    score: 0.25,
    rank: 3,
    passage: {
      ...asRecord(secondPassage.passage, 'result.rankedPassages[1].passage'),
      passageId: 'p3',
    },
  };
  const thirdFact = {
    ...secondFact,
    nodeId: 'fact:f3',
    score: 0.25,
    rank: 3,
    fact: {
      ...asRecord(secondFact.fact, 'result.rankedFacts[1].fact'),
      factId: 'f3',
    },
  };
  const zeroIterationResult = (
    rankedPassages: JsonArray,
    rankedFacts: JsonArray,
    converged: boolean,
    l1Delta: number,
  ): JsonRecord => ({
    ...asRecord(result, 'result'),
    rankedPassages,
    rankedFacts,
    iterations: 0,
    converged,
    l1Delta,
  });
  const requestPatches: BoundedReplacementPatch[] = [
    patch('request', '/corpusId', ''),
    patch('request', '/plan/seeds', [
      { nodeId: 'fact:fixture-fact-inactive', score: 1 },
      { nodeId: 'fact:fixture-fact-inactive', score: 0.5 },
    ]),
    patch('request', '/plan/seeds/0/nodeId', ''),
    patch('request', '/plan/teleportProbability', 2),
    patch('request', '/plan/convergenceEpsilon', 0),
    patch('request', '/plan/maxIterations', 0),
    patch('request', '/plan/hubDegreeThreshold', -1),
    patch('request', '/plan/passageLimit', 0),
    patch('request', '/plan/entityLimit', 0),
  ];
  const exchangePatches: BoundedReplacementPatch[] = [
    patch('result', '/rankedPassages', [firstPassage, secondPassage, thirdPassage]),
    patch('result', '/rankedFacts', [firstFact, secondFact, thirdFact]),
    patch('result', '/rankedPassages', [firstPassage, { ...firstPassage, score: 0.5, rank: 2 }]),
    patch('result', '/rankedPassages', [
      { ...secondPassage, rank: 1 },
      { ...firstPassage, rank: 2 },
    ]),
    patch('result', '/rankedPassages/1/rank', 1),
    patch('result', '/rankedPassages/0/nodeId', 'passage:wrong'),
    patch('result', '/rankedPassages/0/passage/corpusId', 'other-corpus'),
    patch('result', '/rankedFacts', [
      firstFact,
      duplicateFact,
    ]),
    patch('result', '/rankedFacts', [
      { ...secondFact, rank: 1 },
      { ...firstFact, rank: 2 },
    ]),
    patch('result', '/rankedFacts/1/rank', 1),
    patch('result', '/rankedFacts/0/nodeId', 'fact:0'),
    patch('result', '/rankedFacts/0/fact/corpusId', 'other-corpus'),
    patch('result', '/iterations', 21),
    patch('result', '/l1Delta', -1),
    patch('result', '/iterations', 0),
    patch('result', '', zeroIterationResult([], [firstFact, secondFact], true, 0)),
    patch('result', '', zeroIterationResult([], [], false, 0.1)),
    patch('result', '', zeroIterationResult([], [], true, 0.1)),
    patch('result', '/converged', false),
    patch('result', '', { ...asRecord(result, 'result'), converged: false, l1Delta: 0.1 }),
  ];
  return { request: requestPatches, exchange: exchangePatches };
}

function patch(
  root: BoundedReplacementRoot,
  path: string,
  value: BoundedJsonValue,
): BoundedReplacementPatch {
  return { root, path, value };
}

const PATCH_BUILDERS = {
  [BOUNDED_RETRIEVAL_OPERATION_NAMES[0]]: candidatePatches,
  [BOUNDED_RETRIEVAL_OPERATION_NAMES[1]]: factPatches,
  [BOUNDED_RETRIEVAL_OPERATION_NAMES[2]]: pprPatches,
} as const satisfies Readonly<Record<BoundedRetrievalOperationName, PatchBuilder>>;

function assertExchangeKeys(exchanges: Readonly<Record<string, unknown>>): void {
  const keys = Reflect.ownKeys(exchanges);
  if (keys.some((key) => typeof key !== 'string')
    || keys.join('\0') !== BOUNDED_RETRIEVAL_OPERATION_NAMES.join('\0')) {
    throw new Error('bounded retrieval exchanges must use the canonical operation set and order');
  }
}

/** Generate, evaluate, and return the closed witness list in canonical order. */
export function generateBoundedAssertionWitnesses(
  exchanges: Readonly<Record<BoundedRetrievalOperationName, BoundedSemanticExchangeFixture>>,
  programs: BoundedProgramSet = BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS,
): readonly BoundedAssertionWitness[] {
  assertExchangeKeys(exchanges);
  const coverage = deriveBoundedAssertionCoverage(programs);
  const witnesses: BoundedAssertionWitness[] = [];
  for (const operation of BOUNDED_RETRIEVAL_OPERATION_NAMES) {
    const exchange = exchanges[operation];
    const baseline = validateBoundedSemanticExchange(operation, exchange.request, exchange.result);
    if (!baseline.valid) throw new Error(`${operation} baseline is invalid: ${baseline.errors.join('; ')}`);
    const groups = PATCH_BUILDERS[operation](exchange);
    for (const partition of ['request', 'exchange'] as const) {
      const expectedCount = coverage.byOperation[operation][partition];
      const patches = groups[partition];
      if (patches.length !== expectedCount) {
        throw new Error(`${operation} ${partition} witness recipe count ${patches.length} does not cover ${expectedCount} canonical assertions`);
      }
      for (let assertionIndex = 0; assertionIndex < expectedCount; assertionIndex += 1) {
        const identity = { operation, partition, assertionIndex } as const;
        const selectedPatch = patches[assertionIndex]!;
        if (partition === 'request' && selectedPatch.root !== 'request') {
          throw new Error(`${identityKey(identity)} request witness must patch the request root`);
        }
        assertWitnessEvidence(identity, exchange, selectedPatch, programs[operation].refinement);
        witnesses.push({ ...identity, patch: selectedPatch });
      }
    }
  }
  return witnesses;
}

function identityFromUnknown(
  value: Record<string, unknown>,
  path: string,
  coverage: BoundedAssertionCoverage,
  errors: string[],
): BoundedAssertionIdentity | undefined {
  const operation = value.operation;
  const partition = value.partition;
  const assertionIndex = value.assertionIndex;
  if (typeof operation !== 'string' || !BOUNDED_RETRIEVAL_OPERATION_NAMES.includes(operation as BoundedRetrievalOperationName)) {
    errors.push(`${path}.operation is unknown`);
    return undefined;
  }
  if (partition !== 'request' && partition !== 'exchange') {
    errors.push(`${path}.partition is unknown`);
    return undefined;
  }
  const count = coverage.byOperation[operation as BoundedRetrievalOperationName][partition];
  if (typeof assertionIndex !== 'number' || !Number.isSafeInteger(assertionIndex)
    || assertionIndex < 0 || assertionIndex >= count) {
    errors.push(`${path}.assertionIndex is out of range for ${operation}/${partition}`);
    return undefined;
  }
  return { operation: operation as BoundedRetrievalOperationName, partition, assertionIndex };
}

function validateExactObject(
  value: unknown,
  expected: readonly string[],
  path: string,
  errors: string[],
): value is Record<string, unknown> {
  if (!isPlainRecord(value)) {
    errors.push(`${path} must be a plain object`);
    return false;
  }
  const expectedSet = new Set(expected);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !expectedSet.has(key)) errors.push(`${path}.${String(key)} is unknown`);
  }
  for (const key of expected) if (!hasOwn(value, key)) errors.push(`${path}.${key} is required`);
  return true;
}

function appendCoverageErrors(
  actual: readonly (BoundedAssertionIdentity | undefined)[],
  expected: readonly BoundedAssertionIdentity[],
  errors: string[],
): void {
  const expectedCounts = new Map(expected.map((identity) => [identityKey(identity), 1]));
  const actualCounts = new Map<string, number>();
  for (const identity of actual) {
    if (identity) actualCounts.set(identityKey(identity), (actualCounts.get(identityKey(identity)) ?? 0) + 1);
  }
  for (const [key, count] of actualCounts) {
    if (!expectedCounts.has(key)) errors.push(`$.witnesses contains extra identity ${key}`);
    if (count > 1) errors.push(`$.witnesses contains duplicate identity ${key}`);
  }
  for (const key of expectedCounts.keys()) {
    if (!actualCounts.has(key)) errors.push(`$.witnesses is missing identity ${key}`);
  }
  if (actual.length === expected.length
    && actual.every((identity): identity is BoundedAssertionIdentity => identity !== undefined)
    && actual.some((identity, index) => identityKey(identity) !== identityKey(expected[index]!))) {
    errors.push('$.witnesses identities are not in canonical operation/partition/assertion order');
  }
}

function verifyArtifactWitness(
  identity: BoundedAssertionIdentity,
  exchange: BoundedSemanticExchangeFixture,
  patchValue: unknown,
  errors: string[],
  path: string,
): void {
  const patchValidation = validateBoundedReplacementPatch(patchValue, path);
  if (!patchValidation.valid) {
    errors.push(...patchValidation.errors);
    return;
  }
  const patch = patchValue as BoundedReplacementPatch;
  if (identity.partition === 'request' && patch.root !== 'request') {
    errors.push(`${path}.root must be request for a request witness`);
    return;
  }
  try {
    const mutated = applyBoundedReplacementPatch(exchange, patch);
    const shape = validateBoundedSemanticExchangeShape(identity.operation, mutated.request, mutated.result);
    if (!shape.valid) {
      errors.push(`${path} is schema-only: ${shape.errors.join('; ')}`);
      return;
    }
    const program = BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS[identity.operation].refinement;
    const observed = inspectRefinementProgram(
      partialProgram(program, identity.partition, identity.assertionIndex),
      contextFor(mutated),
      rootsFor(identity.operation),
    );
    const failure = observed.failure;
    if (observed.valid
      || failure?.partition !== identity.partition
      || failure.assertionIndex !== identity.assertionIndex
      || failure.kind !== 'false') {
      errors.push(`${path} does not fail at ${identityKey(identity)}: ${formatFailure(failure)}`);
      return;
    }
    if (identity.partition === 'request') {
      if (validateBoundedSemanticRequest(identity.operation, mutated.request).valid) {
        errors.push(`${path} request validation unexpectedly passed`);
      }
    } else {
      const requestValidation = validateBoundedSemanticRequest(identity.operation, mutated.request);
      if (!requestValidation.valid) {
        errors.push(`${path} invalidates request evaluation: ${requestValidation.errors.join('; ')}`);
      } else if (validateBoundedSemanticExchange(identity.operation, mutated.request, mutated.result).valid) {
        errors.push(`${path} full exchange validation unexpectedly passed`);
      }
    }
  } catch (error) {
    errors.push(`${path} failed closed during application: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Validate the complete embedded fixture as a closed consumer artifact. */
export function validateBoundedRetrievalFixture(value: unknown): { valid: boolean; errors: readonly string[] } {
  const errors: string[] = [];
  if (!validateExactObject(value, ['exchanges', 'fixtureVersion', 'witnessVersion', 'witnesses'], '$', errors)) {
    return { valid: false, errors };
  }
  const fixture = value as Record<string, unknown>;
  if (fixture.fixtureVersion !== BOUNDED_RETRIEVAL_FIXTURE_VERSION) errors.push('$.fixtureVersion is unknown');
  if (fixture.witnessVersion !== BOUNDED_RETRIEVAL_WITNESS_VERSION) errors.push('$.witnessVersion is unknown');

  let coverage: BoundedAssertionCoverage;
  try {
    coverage = deriveBoundedAssertionCoverage();
  } catch (error) {
    errors.push(`$.witnesses coverage derivation failed: ${error instanceof Error ? error.message : String(error)}`);
    return { valid: false, errors };
  }

  const exchanges = fixture.exchanges;
  if (!validateExactObject(exchanges, [...BOUNDED_RETRIEVAL_OPERATION_NAMES], '$.exchanges', errors)) {
    return { valid: false, errors };
  }
  if (Object.keys(exchanges).join('\0') !== BOUNDED_RETRIEVAL_OPERATION_NAMES.join('\0')) {
    errors.push('$.exchanges are not in canonical operation order');
  }
  for (const operation of BOUNDED_RETRIEVAL_OPERATION_NAMES) {
    const exchangeValue = (exchanges as Record<string, unknown>)[operation];
    if (!validateExactObject(exchangeValue, ['request', 'result'], `$.exchanges.${operation}`, errors)) continue;
    const exchange = exchangeValue as Record<string, unknown>;
    const shape = validateBoundedSemanticExchangeShape(operation, exchange.request, exchange.result);
    if (!shape.valid) errors.push(...shape.errors.map((error) => `$.exchanges.${operation}${error.slice(1)}`));
    else {
      const semantic = validateBoundedSemanticExchange(operation, exchange.request, exchange.result);
      if (!semantic.valid) errors.push(...semantic.errors.map((error) => `$.exchanges.${operation}${error.slice(1)}`));
    }
  }

  const witnessesValue = fixture.witnesses;
  if (!Array.isArray(witnessesValue)) {
    errors.push('$.witnesses must be an array');
    return { valid: false, errors };
  }
  if (Object.getPrototypeOf(witnessesValue) !== Array.prototype) errors.push('$.witnesses must use the plain Array prototype');
  for (const key of Reflect.ownKeys(witnessesValue)) {
    const index = typeof key === 'string' && /^(0|[1-9]\d*)$/u.test(key) ? Number(key) : Number.NaN;
    if (key !== 'length' && (!Number.isSafeInteger(index) || index < 0 || index >= witnessesValue.length)) {
      errors.push(`$.witnesses.${String(key)} is unknown`);
    }
  }
  const identities: (BoundedAssertionIdentity | undefined)[] = [];
  for (let index = 0; index < witnessesValue.length; index += 1) {
    if (!hasOwn(witnessesValue, String(index))) {
      errors.push(`$.witnesses[${index}] must not be sparse`);
      identities.push(undefined);
      continue;
    }
    const path = `$.witnesses[${index}]`;
    const witnessValue = witnessesValue[index];
    if (!validateExactObject(witnessValue, ['assertionIndex', 'operation', 'partition', 'patch'], path, errors)) {
      identities.push(undefined);
      continue;
    }
    const witness = witnessValue as Record<string, unknown>;
    const identity = identityFromUnknown(witness, path, coverage, errors);
    identities.push(identity);
    if (identity) {
      if (identity.partition === 'request' && isPlainRecord(witness.patch)
        && witness.patch.root !== 'request') {
        errors.push(`${path}.patch.root must be request for a request witness`);
      }
      const exchangeValue = (exchanges as Record<string, unknown>)[identity.operation];
      if (isPlainRecord(exchangeValue)
        && hasOwn(exchangeValue, 'request')
        && hasOwn(exchangeValue, 'result')) {
        verifyArtifactWitness(
          identity,
          exchangeValue as unknown as BoundedSemanticExchangeFixture,
          witness.patch,
          errors,
          `${path}.patch`,
        );
      }
    }
  }
  appendCoverageErrors(identities, coverage.identities, errors);
  return { valid: errors.length === 0, errors };
}
