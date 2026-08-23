/**
 * The Synapse-owned v15 retrieval policy.
 *
 * This module deliberately contains policy and pure helpers only.  It does
 * not talk to GraphDB and it does not provide a native implementation of any
 * bounded operation.  The legacy JavaScript retrieval path uses the same
 * ordering/normalisation helpers as the future bounded adapter.
 */

import type { Fact } from '../memory/fact.js';
import type { Passage } from '../memory/passage.js';
import type { Schema } from '../memory/schema.js';
import type {
  FilteredMemoryCandidates,
  NodeInitializationVector,
  QueryRequest,
} from './memoryFilter.js';
import type { RankedNode, TransitionEntry } from './ppr.js';
import type { QueryFeatureFlags } from '../config/featureFlags.js';

export const V15_RETRIEVAL_PLAN_VERSION = 'V15RetrievalRequestPlan@1' as const;
export const V15_RETRIEVAL_PROFILE = 'v15' as const;
export const V15_ENTITY_NORMALIZATION_DIGEST =
  'v15-entity-normalization-ecmascript-tolowercase-unicode16.0.0@1' as const;
export const V15_SCHEMA_SEARCH_LIMIT = 10 as const;
export const V15_EXPANSION_ATTENUATION = 0.3 as const;
export const V15_EXPANSION_LIMIT = 20 as const;

export type V15RetrievalProfile = typeof V15_RETRIEVAL_PROFILE;
export type V15SearchNamespace = 'passage' | 'fact' | 'schema';
export type V15SearchSlotId = V15SearchNamespace;

export interface V15SearchSlot {
  readonly slotId: V15SearchSlotId;
  readonly namespace: V15SearchNamespace;
  readonly queryVector: readonly number[];
  readonly threshold: number;
  readonly limit: number;
}

export interface V15CandidateSearchPlan {
  readonly slots: readonly V15SearchSlot[];
}

export interface V15EntitySeed {
  readonly key: string;
  /** The non-negative maximum of matching finite seed similarities. */
  readonly score: number;
}

export interface V15FactExpansionPlan {
  readonly seedEntities: readonly V15EntitySeed[];
  readonly excludedSeedFactIds: readonly string[];
  readonly attenuation: number;
  readonly limit: number;
  readonly normalizationContractDigest: string;
}

export interface V15PprSeed {
  readonly nodeId: string;
  /** Signed finite scores are intentional v15 behaviour. */
  readonly score: number;
}

export interface V15PprMaterializationPlan {
  readonly seeds: readonly V15PprSeed[];
  readonly teleportProbability: number;
  readonly convergenceEpsilon: number;
  readonly maxIterations: number;
  readonly hubDegreeThreshold: number;
  readonly passageLimit: number;
  readonly entityLimit: number;
}

export interface V15PprPolicy {
  readonly teleportProbability: number;
  readonly convergenceEpsilon: number;
  readonly maxIterations: number;
  readonly hubDegreeThreshold: number;
  readonly passageLimit: number;
  readonly entityLimit: number;
}

export interface V15ExpandedFactSeed {
  readonly factId: string;
  readonly score: number;
}

/** Static machine-readable policy known before any v15 retrieval data access. */
export interface V15RetrievalRequestPlan {
  readonly version: typeof V15_RETRIEVAL_PLAN_VERSION;
  readonly profile: V15RetrievalProfile;
  readonly corpusId: string;
  readonly comparisonMode: boolean;
  readonly contextTokenLimit: number;
  readonly candidateSearch: V15CandidateSearchPlan;
  readonly pprPolicy: V15PprPolicy;
}

/** @deprecated Use the staged V15RetrievalRequestPlan name. */
export type V15RetrievalPlan = V15RetrievalRequestPlan;

export interface V15RetrievalPlanOptions {
  readonly comparisonMode?: boolean;
  /** The active Synapse feature profile must be checked before plan output. */
  readonly featureFlags: QueryFeatureFlags;
  /** Supplied by Synapse's existing QueryService/config authority. */
  readonly teleportProbability: number;
  readonly convergenceEpsilon: number;
  readonly maxIterations: number;
  readonly hubDegreeThreshold: number;
}

/** A score-bearing native id used by candidate and tie-order helpers. */
export interface V15ScoredId {
  readonly id: string;
  readonly score: number;
}

export interface V15RankedAssociation<TItem> {
  readonly item: TItem;
  readonly node: RankedNode;
  /** Rank among materialized items in the requested layer (one-based). */
  readonly rank: number;
}

export type V15PlanValidationCode = 'INVALID_PLAN' | 'UNSUPPORTED_PROFILE';

export class V15RetrievalPlanValidationError extends Error {
  public readonly code: V15PlanValidationCode;

  public constructor(code: V15PlanValidationCode, message: string) {
    super(message);
    this.name = 'V15RetrievalPlanValidationError';
    this.code = code;
  }
}

export type V15UnsupportedFeature = keyof QueryFeatureFlags;

const V15_FEATURE_FLAG_KEYS: readonly V15UnsupportedFeature[] = [
  'enableAliasHints',
  'enableComparisonVerification',
  'enableDictionaryInjection',
  'enableHypernymExpansion',
  'enableMultiHopReasoning',
  'enableSubQueryDecomposition',
  'enableThesaurusExpansion',
];

/** Returns active flags for which no bounded v1 plan exists. */
export function unsupportedV15Features(flags: QueryFeatureFlags): V15UnsupportedFeature[] {
  return V15_FEATURE_FLAG_KEYS.filter((key) => flags[key] === true);
}

/** Fail closed before a bounded plan can be advertised or sent to an owner. */
export function assertV15FeatureProfile(flags: QueryFeatureFlags): void {
  const unsupported = unsupportedV15Features(flags);
  if (unsupported.length > 0) {
    throw new V15RetrievalPlanValidationError(
      'UNSUPPORTED_PROFILE',
      `v15 bounded retrieval does not support active feature flags: ${unsupported.join(', ')}`,
    );
  }
}

/** ECMAScript `String.prototype.toLowerCase()` is the v15 authority. */
export function normalizeV15Entity(value: string): string {
  return value.toLowerCase();
}

/** Canonical id order used by seed, node, and tie-breaking helpers. */
export function compareV15Ids(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Score descending with non-finite values last.  Plans reject non-finite
 * scores, but keeping the legacy helper total makes malformed backend data
 * deterministic instead of relying on Array#sort's implementation details.
 */
export function compareV15ScoresDescending(left: number, right: number): number {
  const leftFinite = Number.isFinite(left);
  const rightFinite = Number.isFinite(right);
  if (leftFinite && !rightFinite) return -1;
  if (!leftFinite && rightFinite) return 1;
  if (!leftFinite && !rightFinite) return 0;
  if (left > right) return -1;
  if (left < right) return 1;
  return 0;
}

export function compareV15ScoreThenId(
  left: V15ScoredId,
  right: V15ScoredId,
): number {
  return compareV15ScoresDescending(left.score, right.score)
    || compareV15Ids(left.id, right.id);
}

/** Returns a new array; callers never observe an in-place reorder. */
export function orderV15ScoreThenId<T extends V15ScoredId>(
  values: readonly T[],
): T[] {
  return [...values].sort(compareV15ScoreThenId);
}

/** Canonical order for seed entries, independent of object insertion order. */
export function orderV15Seeds<T extends { readonly nodeId: string }>(
  values: readonly T[],
): T[] {
  return [...values].sort((left, right) => compareV15Ids(left.nodeId, right.nodeId));
}

export function orderV15RankedNodes<T extends RankedNode>(
  values: readonly T[],
): T[] {
  return [...values].sort((left, right) =>
    compareV15ScoresDescending(left.score, right.score)
    || compareV15Ids(left.nodeId, right.nodeId));
}

/** IEEE-754-inspired total order for graph edge weights. */
export function compareV15FloatingTotal(left: number, right: number): number {
  if (Object.is(left, right)) return 0;
  const leftNaN = Number.isNaN(left);
  const rightNaN = Number.isNaN(right);
  if (leftNaN || rightNaN) {
    if (leftNaN && rightNaN) return 0;
    return leftNaN ? 1 : -1;
  }
  if (left === 0 && right === 0) {
    return Object.is(left, -0) ? -1 : 1;
  }
  return left < right ? -1 : 1;
}

export function compareV15Transitions(
  left: TransitionEntry,
  right: TransitionEntry,
): number {
  return compareV15Ids(left.sourceNodeId, right.sourceNodeId)
    || compareV15Ids(left.targetNodeId, right.targetNodeId)
    || compareV15FloatingTotal(left.weight, right.weight);
}

export function orderV15Transitions(
  values: readonly TransitionEntry[],
): TransitionEntry[] {
  return [...values].sort(compareV15Transitions);
}

function nodeObjectId(node: RankedNode): string {
  // SimplePPR calls schema nodes `schema:*` while the domain layer name is
  // `ontology`; keep this mapping explicit rather than deriving a prefix that
  // can never match the canonical node id.
  const prefix = node.layer === 'ontology' ? 'schema:' : `${node.layer}:`;
  return node.nodeId.startsWith(prefix)
    ? node.nodeId.slice(prefix.length)
    : node.nodeId;
}

/**
 * Join ranked nodes to materialized domain objects by canonical id.  This is
 * deliberately not a zip: a missing or reordered object cannot borrow a
 * neighbouring rank's score.
 */
export function associateV15RankedObjects<TItem>(
  rankedNodes: readonly RankedNode[],
  items: readonly TItem[],
  layer: RankedNode['layer'],
  getId: (item: TItem) => string,
): V15RankedAssociation<TItem>[] {
  const byId = new Map(items.map((item) => [getId(item), item]));
  const associated: V15RankedAssociation<TItem>[] = [];
  for (const node of rankedNodes) {
    if (node.layer !== layer) continue;
    const item = byId.get(nodeObjectId(node));
    if (!item) continue;
    associated.push({ item, node, rank: associated.length + 1 });
  }
  return associated;
}

export function associateV15RankedPassages(
  rankedNodes: readonly RankedNode[],
  passages: readonly Passage[],
): V15RankedAssociation<Passage>[] {
  return associateV15RankedObjects(rankedNodes, passages, 'passage', (item) => item.passageId);
}

export function associateV15RankedFacts(
  rankedNodes: readonly RankedNode[],
  facts: readonly Fact[],
): V15RankedAssociation<Fact>[] {
  return associateV15RankedObjects(rankedNodes, facts, 'fact', (item) => item.factId);
}

export function associateV15RankedSchemas(
  rankedNodes: readonly RankedNode[],
  schemas: readonly Schema[],
): V15RankedAssociation<Schema>[] {
  return associateV15RankedObjects(rankedNodes, schemas, 'ontology', (item) => item.schemaId);
}

export function buildV15SearchSlots(
  query: QueryRequest,
  queryVector: readonly number[],
): V15SearchSlot[] {
  const vector = [...queryVector];
  return [
    { slotId: 'passage', namespace: 'passage', queryVector: [...vector], threshold: query.threshold, limit: query.topK },
    { slotId: 'fact', namespace: 'fact', queryVector: [...vector], threshold: query.threshold, limit: query.topM },
    { slotId: 'schema', namespace: 'schema', queryVector: [...vector], threshold: query.threshold, limit: V15_SCHEMA_SEARCH_LIMIT },
  ];
}

/**
 * Build the explicit comparison expansion request used by both paths.
 * Matching seed similarities are retained as signed values until the v15
 * zero-floor is applied, exactly as SimpleNodeInitializer did historically.
 */
export function buildV15FactExpansionPlan(
  candidates: FilteredMemoryCandidates,
  comparisonMode: boolean,
): V15FactExpansionPlan | null {
  if (!comparisonMode || candidates.facts.length === 0) return null;

  const seedScores = new Map<string, number>();
  for (const candidate of candidates.facts) {
    if (!Number.isFinite(candidate.similarity)) {
      throw new V15RetrievalPlanValidationError(
        'INVALID_PLAN',
        `candidate fact ${candidate.item.factId} similarity must be finite`,
      );
    }
    for (const entity of [candidate.item.headEntity, candidate.item.tailEntity]) {
      const key = normalizeV15Entity(entity);
      const previous = seedScores.get(key);
      if (previous === undefined || candidate.similarity > previous) {
        seedScores.set(key, candidate.similarity);
      }
    }
  }

  const seedEntities = [...seedScores.entries()]
    .map(([key, score]) => ({ key, score: Math.max(0, score) }))
    .sort((left, right) => compareV15Ids(left.key, right.key));

  const excludedSeedFactIds = [...new Set(candidates.facts.map((candidate) => candidate.item.factId))]
    .sort(compareV15Ids);

  return {
    seedEntities,
    excludedSeedFactIds,
    attenuation: V15_EXPANSION_ATTENUATION,
    limit: V15_EXPANSION_LIMIT,
    normalizationContractDigest: V15_ENTITY_NORMALIZATION_DIGEST,
  };
}

/** Compile the single expansion authority once for a bounded/full fact scan. */
export function compileV15FactExpansionEvaluator(
  plan: V15FactExpansionPlan,
): (fact: Fact) => V15ExpandedFactSeed | null {
  const excluded = new Set(plan.excludedSeedFactIds);
  const seeds = new Map(plan.seedEntities.map((seed) => [seed.key, seed.score]));
  return (fact) => {
    if (excluded.has(fact.factId)) return null;
    const headScore = seeds.get(normalizeV15Entity(fact.headEntity));
    const tailScore = seeds.get(normalizeV15Entity(fact.tailEntity));
    if (headScore === undefined && tailScore === undefined) return null;
    return {
      factId: fact.factId,
      score: Math.max(headScore ?? 0, tailScore ?? 0) * plan.attenuation,
    };
  };
}

export function buildV15PprMaterializationPlan(
  policy: V15PprPolicy,
  initialVector: NodeInitializationVector,
): V15PprMaterializationPlan {
  const rawSeeds = Object.entries(initialVector.scores).map(([nodeId, score]) => {
    if (!Number.isFinite(score)) {
      throw new V15RetrievalPlanValidationError(
        'INVALID_PLAN',
        `initial vector seed ${nodeId} score must be finite`,
      );
    }
    return { nodeId, score };
  });
  return {
    seeds: orderV15Seeds(rawSeeds),
    ...policy,
  };
}

/** Shared seed builder used after either legacy or bounded expansion. */
export function buildV15InitialVector(
  candidates: FilteredMemoryCandidates,
  expandedFacts: readonly V15ExpandedFactSeed[] = [],
): NodeInitializationVector {
  const scores: Record<string, number> = {};
  for (const candidate of candidates.facts) scores[`fact:${candidate.item.factId}`] = candidate.similarity;
  for (const expanded of expandedFacts) {
    if (!Number.isFinite(expanded.score)) {
      throw new V15RetrievalPlanValidationError(
        'INVALID_PLAN',
        `expanded fact ${expanded.factId} score must be finite`,
      );
    }
    if (scores[`fact:${expanded.factId}`] === undefined) {
      scores[`fact:${expanded.factId}`] = expanded.score;
    }
  }
  for (const candidate of candidates.passages) scores[`passage:${candidate.item.passageId}`] = candidate.similarity;
  for (const candidate of candidates.ontology) scores[`schema:${candidate.item.schemaId}`] = candidate.similarity;
  return { scores, fallbackTriggered: candidates.fallbackRequired };
}

export function buildV15RetrievalRequestPlan(
  query: QueryRequest,
  queryVector: readonly number[],
  options: V15RetrievalPlanOptions,
): V15RetrievalRequestPlan {
  assertV15FeatureProfile(options.featureFlags);
  const comparisonMode = options.comparisonMode ?? false;
  const plan: V15RetrievalRequestPlan = {
    version: V15_RETRIEVAL_PLAN_VERSION,
    profile: V15_RETRIEVAL_PROFILE,
    corpusId: query.corpusId,
    comparisonMode,
    contextTokenLimit: query.contextTokenLimit,
    candidateSearch: { slots: buildV15SearchSlots(query, queryVector) },
    pprPolicy: {
      teleportProbability: options.teleportProbability,
      convergenceEpsilon: options.convergenceEpsilon,
      maxIterations: options.maxIterations,
      hubDegreeThreshold: options.hubDegreeThreshold,
      passageLimit: query.topK,
      entityLimit: query.topM,
    },
  };
  validateV15RetrievalRequestPlan(plan);
  return plan;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new V15RetrievalPlanValidationError('INVALID_PLAN', message);
}

function unsupportedProfile(value: unknown): never {
  throw new V15RetrievalPlanValidationError(
    'UNSUPPORTED_PROFILE',
    `Unsupported v15 retrieval profile: ${String(value)}`,
  );
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) invalid(`${path} must be an object`);
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], path: string): void {
  const allowed = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(`${path}.${key} is not supported`);
  }
  for (const key of expected) {
    if (!(key in value)) invalid(`${path}.${key} is required`);
  }
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) invalid(`${path} must be a non-empty string`);
  return value;
}

function finiteValue(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(`${path} must be finite`);
  return value;
}

function positiveInteger(value: unknown, path: string): number {
  const number = finiteValue(value, path);
  if (!Number.isSafeInteger(number) || number <= 0) invalid(`${path} must be a positive safe integer`);
  return number;
}

function finiteVector(value: unknown, path: string): void {
  if (!Array.isArray(value) || value.length === 0) invalid(`${path} must be a non-empty array`);
  value.forEach((entry, index) => { finiteValue(entry, `${path}[${index}]`); });
}

function validateSeed(value: unknown, path: string): void {
  const seed = record(value, path);
  exactKeys(seed, ['nodeId', 'score'], path);
  stringValue(seed.nodeId, `${path}.nodeId`);
  finiteValue(seed.score, `${path}.score`);
}

function validatePprPolicy(ppr: Record<string, unknown>, path: string): void {
  const teleportProbability = finiteValue(ppr.teleportProbability, `${path}.teleportProbability`);
  if (teleportProbability < 0 || teleportProbability > 1) invalid(`${path}.teleportProbability must be in [0, 1]`);
  const convergenceEpsilon = finiteValue(ppr.convergenceEpsilon, `${path}.convergenceEpsilon`);
  if (convergenceEpsilon <= 0) invalid(`${path}.convergenceEpsilon must be positive`);
  positiveInteger(ppr.maxIterations, `${path}.maxIterations`);
  const hubDegreeThreshold = finiteValue(ppr.hubDegreeThreshold, `${path}.hubDegreeThreshold`);
  if (!Number.isSafeInteger(hubDegreeThreshold) || hubDegreeThreshold < 0) invalid(`${path}.hubDegreeThreshold must be a non-negative safe integer`);
  positiveInteger(ppr.passageLimit, `${path}.passageLimit`);
  positiveInteger(ppr.entityLimit, `${path}.entityLimit`);
}

export function validateV15RetrievalRequestPlan(input: unknown): V15RetrievalRequestPlan {
  const plan = record(input, 'plan');
  exactKeys(plan, [
    'version', 'profile', 'corpusId', 'comparisonMode', 'contextTokenLimit',
    'candidateSearch', 'pprPolicy',
  ], 'plan');
  if (plan.version !== V15_RETRIEVAL_PLAN_VERSION) {
    invalid(`plan.version must be ${V15_RETRIEVAL_PLAN_VERSION}`);
  }
  if (plan.profile !== V15_RETRIEVAL_PROFILE) unsupportedProfile(plan.profile);
  stringValue(plan.corpusId, 'plan.corpusId');
  if (typeof plan.comparisonMode !== 'boolean') invalid('plan.comparisonMode must be boolean');
  positiveInteger(plan.contextTokenLimit, 'plan.contextTokenLimit');

  const candidateSearch = record(plan.candidateSearch, 'plan.candidateSearch');
  exactKeys(candidateSearch, ['slots'], 'plan.candidateSearch');
  if (!Array.isArray(candidateSearch.slots) || candidateSearch.slots.length !== 3) {
    invalid('plan.candidateSearch.slots must contain passage, fact, and schema exactly once');
  }
  const expectedSlots: readonly V15SearchSlotId[] = ['passage', 'fact', 'schema'];
  candidateSearch.slots.forEach((entry, index) => {
    const slot = record(entry, `plan.candidateSearch.slots[${index}]`);
    exactKeys(slot, ['slotId', 'namespace', 'queryVector', 'threshold', 'limit'], `plan.candidateSearch.slots[${index}]`);
    const expected = expectedSlots[index];
    if (slot.slotId !== expected || slot.namespace !== expected) {
      invalid(`plan.candidateSearch.slots[${index}] must be ${String(expected)}`);
    }
    finiteVector(slot.queryVector, `plan.candidateSearch.slots[${index}].queryVector`);
    const threshold = finiteValue(slot.threshold, `plan.candidateSearch.slots[${index}].threshold`);
    if (threshold < -1 || threshold > 1) invalid(`plan.candidateSearch.slots[${index}].threshold must be in [-1, 1]`);
    positiveInteger(slot.limit, `plan.candidateSearch.slots[${index}].limit`);
  });

  const ppr = record(plan.pprPolicy, 'plan.pprPolicy');
  exactKeys(ppr, [
    'teleportProbability', 'convergenceEpsilon', 'maxIterations',
    'hubDegreeThreshold', 'passageLimit', 'entityLimit',
  ], 'plan.pprPolicy');
  validatePprPolicy(ppr, 'plan.pprPolicy');

  return input as V15RetrievalRequestPlan;
}

export function validateV15FactExpansionPlan(input: unknown): V15FactExpansionPlan {
  const expansion = record(input, 'factExpansion');
  exactKeys(expansion, [
    'seedEntities', 'excludedSeedFactIds', 'attenuation', 'limit', 'normalizationContractDigest',
  ], 'factExpansion');
  if (!Array.isArray(expansion.seedEntities)) invalid('factExpansion.seedEntities must be an array');
  expansion.seedEntities.forEach((entry, index) => {
    const seed = record(entry, `factExpansion.seedEntities[${index}]`);
    exactKeys(seed, ['key', 'score'], `factExpansion.seedEntities[${index}]`);
    stringValue(seed.key, `factExpansion.seedEntities[${index}].key`);
    const score = finiteValue(seed.score, `factExpansion.seedEntities[${index}].score`);
    if (score < 0) invalid(`factExpansion.seedEntities[${index}].score must be non-negative`);
  });
  if (!Array.isArray(expansion.excludedSeedFactIds)) invalid('factExpansion.excludedSeedFactIds must be an array');
  expansion.excludedSeedFactIds.forEach((entry, index) => stringValue(entry, `factExpansion.excludedSeedFactIds[${index}]`));
  const attenuation = finiteValue(expansion.attenuation, 'factExpansion.attenuation');
  if (attenuation < 0) invalid('factExpansion.attenuation must be non-negative');
  positiveInteger(expansion.limit, 'factExpansion.limit');
  if (expansion.normalizationContractDigest !== V15_ENTITY_NORMALIZATION_DIGEST) {
    invalid(`factExpansion.normalizationContractDigest must be ${V15_ENTITY_NORMALIZATION_DIGEST}`);
  }
  return input as unknown as V15FactExpansionPlan;
}

export function validateV15PprMaterializationPlan(input: unknown): V15PprMaterializationPlan {
  const ppr = record(input, 'pprMaterialization');
  exactKeys(ppr, [
    'seeds', 'teleportProbability', 'convergenceEpsilon', 'maxIterations',
    'hubDegreeThreshold', 'passageLimit', 'entityLimit',
  ], 'pprMaterialization');
  if (!Array.isArray(ppr.seeds)) invalid('pprMaterialization.seeds must be an array');
  ppr.seeds.forEach((entry, index) => validateSeed(entry, `pprMaterialization.seeds[${index}]`));
  validatePprPolicy(ppr, 'pprMaterialization');
  return input as unknown as V15PprMaterializationPlan;
}

export function assertV15RetrievalRequestPlan(input: unknown): asserts input is V15RetrievalRequestPlan {
  validateV15RetrievalRequestPlan(input);
}

export function isV15RetrievalRequestPlan(input: unknown): input is V15RetrievalRequestPlan {
  try {
    validateV15RetrievalRequestPlan(input);
    return true;
  } catch {
    return false;
  }
}

/** @deprecated staged-plan compatibility aliases. */
export const validateV15RetrievalPlan = validateV15RetrievalRequestPlan;
export const assertV15RetrievalPlan = assertV15RetrievalRequestPlan;
export const isV15RetrievalPlan = isV15RetrievalRequestPlan;
