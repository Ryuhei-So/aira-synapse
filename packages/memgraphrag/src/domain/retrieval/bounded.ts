/**
 * Service/contract checkpoint for the bounded GraphDB data plane.
 *
 * These are ports and orchestration contracts only.  The native process is
 * intentionally absent: Literature Hub owns the transport/lease authority,
 * while GraphDB will later implement the three operation ports.
 */

import type { Fact } from '../memory/fact.js';
import type { Passage } from '../memory/passage.js';
import type { Schema } from '../memory/schema.js';
import { validateDomainObject } from '../memory/domainContract.js';
import {
  CANDIDATE_SEARCH_BOUNDED_V1,
  FACT_EXPAND_BOUNDED_V1,
  PPR_MATERIALIZE_BOUNDED_V1,
} from './boundedContract.js';
export {
  CANDIDATE_SEARCH_BOUNDED_V1,
  FACT_EXPAND_BOUNDED_V1,
  PPR_MATERIALIZE_BOUNDED_V1,
} from './boundedContract.js';
import type { FilteredMemoryCandidates, MemoryCandidate } from './memoryFilter.js';
import {
  assertV15RetrievalRequestPlan,
  buildV15FactExpansionPlan,
  buildV15InitialVector,
  buildV15PprMaterializationPlan,
  compileV15FactExpansionEvaluator,
  compareV15ScoreThenId,
  validateV15FactExpansionPlan,
  validateV15PprMaterializationPlan,
  V15_RETRIEVAL_PLAN_VERSION,
  type V15FactExpansionPlan,
  type V15PprMaterializationPlan,
  type V15RetrievalRequestPlan,
  type V15SearchSlot,
  type V15SearchSlotId,
} from './v15Plan.js';

/** JSON-safe generation at every existing boundary. */
export type Generation = number;
export const MAX_SAFE_GENERATION = Number.MAX_SAFE_INTEGER;

export type BoundedSessionErrorCode =
  | 'INVALID_GENERATION'
  | 'GENERATION_MISMATCH'
  | 'SESSION_MISMATCH'
  | 'SESSION_BUSY'
  | 'INVALID_RESPONSE';

export class BoundedGenerationSessionError extends Error {
  public readonly code: BoundedSessionErrorCode;

  public constructor(code: BoundedSessionErrorCode, message: string) {
    super(message);
    this.name = 'BoundedGenerationSessionError';
    this.code = code;
  }
}

/** Both primary retrieval and cleanup failures remain observable. */
export class GenerationSessionCleanupError extends AggregateError {
  public readonly primaryError: unknown;
  public readonly cleanupError: unknown;

  public constructor(primaryError: unknown, cleanupError: unknown) {
    super([primaryError, cleanupError], 'Generation retrieval and cleanup both failed');
    this.name = 'GenerationSessionCleanupError';
    this.primaryError = primaryError;
    this.cleanupError = cleanupError;
  }
}

export function assertGeneration(value: unknown, path = 'generation'): asserts value is Generation {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 0
    || value > MAX_SAFE_GENERATION
  ) {
    throw new BoundedGenerationSessionError(
      'INVALID_GENERATION',
      `${path} must be a JSON-safe integer in 0..${MAX_SAFE_GENERATION}`,
    );
  }
}

export function toGeneration(value: number): Generation {
  assertGeneration(value);
  return value;
}

export interface GenerationLease {
  readonly generation: Generation;
  /** Owner-issued identity; never a caller role or native lease claim. */
  readonly sessionId: string;
}

export interface CandidateSearchBoundedRequest {
  readonly generation: Generation;
  readonly corpusId: string;
  readonly slots: readonly V15SearchSlot[];
}

export interface BoundedCandidateHit<TItem> {
  readonly id: string;
  readonly score: number;
  readonly item: TItem;
}

export type CandidateSearchSlotResult =
  | {
    readonly slotId: 'passage';
    readonly namespace: 'passage';
    readonly hits: readonly BoundedCandidateHit<Passage>[];
  }
  | {
    readonly slotId: 'fact';
    readonly namespace: 'fact';
    readonly hits: readonly BoundedCandidateHit<Fact>[];
  }
  | {
    readonly slotId: 'schema';
    readonly namespace: 'schema';
    readonly hits: readonly BoundedCandidateHit<Schema>[];
  };

export interface CandidateSearchBoundedResponse {
  readonly generation: Generation;
  readonly sessionId: string;
  readonly slots: readonly CandidateSearchSlotResult[];
}

export interface CandidateSearchBoundedPort {
  readonly candidateSearchBounded: (
    request: CandidateSearchBoundedRequest,
  ) => Promise<CandidateSearchBoundedResponse>;
}

export interface FactExpandBoundedRequest {
  readonly generation: Generation;
  readonly corpusId: string;
  readonly plan: V15FactExpansionPlan;
}

export interface BoundedFactExpansionHit {
  readonly factId: string;
  readonly score: number;
  readonly fact: Fact;
}

export interface FactExpandBoundedResponse {
  readonly generation: Generation;
  readonly sessionId: string;
  readonly facts: readonly BoundedFactExpansionHit[];
}

export interface FactExpandBoundedPort {
  readonly factExpandBounded: (
    request: FactExpandBoundedRequest,
  ) => Promise<FactExpandBoundedResponse>;
}

export interface PprMaterializeBoundedRequest {
  readonly generation: Generation;
  readonly corpusId: string;
  readonly plan: V15PprMaterializationPlan;
}

export interface BoundedRankedPassage {
  readonly nodeId: string;
  readonly score: number;
  readonly rank: number;
  readonly passage: Passage;
}

export interface BoundedRankedFact {
  readonly nodeId: string;
  readonly score: number;
  readonly rank: number;
  readonly fact: Fact;
}

export interface PprMaterializeBoundedResponse {
  readonly generation: Generation;
  readonly sessionId: string;
  readonly rankedPassages: readonly BoundedRankedPassage[];
  readonly rankedFacts: readonly BoundedRankedFact[];
  readonly iterations: number;
  readonly converged: boolean;
  readonly l1Delta: number;
}

export interface PprMaterializeBoundedPort {
  readonly pprMaterializeBounded: (
    request: PprMaterializeBoundedRequest,
  ) => Promise<PprMaterializeBoundedResponse>;
}

export interface BoundedRetrievalDataPlane
  extends CandidateSearchBoundedPort, FactExpandBoundedPort, PprMaterializeBoundedPort {}

export interface BoundedRetrievalResult {
  readonly generation: Generation;
  readonly candidateSearch: CandidateSearchBoundedResponse;
  readonly factExpansion: FactExpandBoundedResponse | null;
  readonly pprMaterialization: PprMaterializeBoundedResponse;
}

/**
 * Literature Hub's owner/session transport.  The operation methods are
 * connection-bound; requests carry generation but never a caller role or a
 * lease claim.  `renewGeneration` must return the same exact generation and
 * session identity for this v1 single-query session.
 */
export interface GenerationSessionTransport extends BoundedRetrievalDataPlane {
  acquireGeneration: () => Promise<GenerationLease>;
  renewGeneration: (lease: GenerationLease) => Promise<GenerationLease>;
  releaseGeneration: (lease: GenerationLease) => Promise<void>;
}

export interface GenerationSession {
  run(plan: V15RetrievalRequestPlan): Promise<BoundedRetrievalResult>;
}

export interface GenerationSessionClock {
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface BoundedGenerationSessionOptions {
  /** Must be below the owner lease TTL in the active deployment. */
  readonly heartbeatIntervalMs?: number;
  readonly clock?: GenerationSessionClock;
}

const SYSTEM_CLOCK: GenerationSessionClock = {
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

function validateLease(lease: GenerationLease): void {
  assertGeneration(lease?.generation, 'lease.generation');
  if (typeof lease.sessionId !== 'string' || lease.sessionId.length === 0) {
    throw new BoundedGenerationSessionError(
      'SESSION_MISMATCH',
      'Owner returned an empty generation-session identity',
    );
  }
}

function validateRenewedLease(expected: GenerationLease, renewed: GenerationLease): void {
  validateLease(renewed);
  if (renewed.generation !== expected.generation) {
    throw new BoundedGenerationSessionError(
      'GENERATION_MISMATCH',
      `Generation changed during one retrieval (${expected.generation} -> ${renewed.generation})`,
    );
  }
  if (renewed.sessionId !== expected.sessionId) {
    throw new BoundedGenerationSessionError(
      'SESSION_MISMATCH',
      'Owner replaced the active generation session during retrieval',
    );
  }
}

function validateOperationEnvelope(
  expected: GenerationLease,
  actual: { readonly generation: Generation; readonly sessionId: string },
  operation: string,
): void {
  if (actual.generation !== expected.generation) {
    throw new BoundedGenerationSessionError(
      'GENERATION_MISMATCH',
      `${operation} returned generation ${String(actual.generation)}; expected ${expected.generation}`,
    );
  }
  if (actual.sessionId !== expected.sessionId) {
    throw new BoundedGenerationSessionError(
      'SESSION_MISMATCH',
      `${operation} returned a different generation session`,
    );
  }
}

function invalidResponse(message: string): never {
  throw new BoundedGenerationSessionError('INVALID_RESPONSE', message);
}

function assertBoundedDomainObject(
  namespace: V15SearchSlotId,
  value: unknown,
  path: string,
): void {
  const validation = validateDomainObject(namespace, value);
  if (!validation.valid) {
    invalidResponse(`${path} violates the ${namespace} domain contract: ${validation.errors.join('; ')}`);
  }
}

function objectIdentity(
  namespace: V15SearchSlotId,
  item: Passage | Fact | Schema,
): { id: string; corpusId: string } {
  if (typeof item !== 'object' || item === null) {
    return invalidResponse(`candidate ${namespace} hit has no domain object`);
  }
  if (namespace === 'passage' && 'passageId' in item) return { id: item.passageId, corpusId: item.corpusId };
  if (namespace === 'fact' && 'factId' in item) return { id: item.factId, corpusId: item.corpusId };
  if (namespace === 'schema' && 'schemaId' in item) return { id: item.schemaId, corpusId: item.corpusId };
  return invalidResponse(`candidate ${namespace} hit has the wrong domain object kind`);
}

function validateCandidateSearchResponse(
  plan: V15RetrievalRequestPlan,
  response: CandidateSearchBoundedResponse,
): FilteredMemoryCandidates {
  if (!Array.isArray(response.slots) || response.slots.length !== plan.candidateSearch.slots.length) {
    invalidResponse('candidate response slot cardinality does not match the request');
  }
  const passages: MemoryCandidate<Passage>[] = [];
  const facts: MemoryCandidate<Fact>[] = [];
  const ontology: MemoryCandidate<Schema>[] = [];

  for (let slotIndex = 0; slotIndex < plan.candidateSearch.slots.length; slotIndex += 1) {
    const requested = plan.candidateSearch.slots[slotIndex]!;
    const actual = response.slots[slotIndex]!;
    if (actual.slotId !== requested.slotId || actual.namespace !== requested.namespace) {
      invalidResponse(`candidate response slot ${slotIndex} does not match ${requested.slotId}`);
    }
    if (!Array.isArray(actual.hits) || actual.hits.length > requested.limit) {
      invalidResponse(`candidate response slot ${requested.slotId} exceeds its result limit`);
    }
    const seen = new Set<string>();
    let previous: BoundedCandidateHit<Passage | Fact | Schema> | undefined;
    for (const hit of actual.hits as readonly BoundedCandidateHit<Passage | Fact | Schema>[]) {
      if (typeof hit !== 'object' || hit === null) {
        invalidResponse(`candidate response slot ${requested.slotId} contains a malformed hit`);
      }
      if (typeof hit.id !== 'string' || hit.id.length === 0 || !Number.isFinite(hit.score)) {
        invalidResponse(`candidate response slot ${requested.slotId} contains an invalid id or score`);
      }
      if (hit.score < -1 || hit.score > 1 || hit.score < requested.threshold) {
        invalidResponse(`candidate response slot ${requested.slotId} contains a score outside its contract`);
      }
      if (seen.has(hit.id)) invalidResponse(`candidate response slot ${requested.slotId} contains duplicate id ${hit.id}`);
      seen.add(hit.id);
      if (previous && compareV15ScoreThenId(previous, hit) >= 0) {
        invalidResponse(`candidate response slot ${requested.slotId} is not strictly score/id ordered`);
      }
      previous = hit;
      assertBoundedDomainObject(requested.namespace, hit.item, `candidate ${hit.id}`);
      const identity = objectIdentity(requested.namespace, hit.item);
      if (hit.id !== `${requested.namespace}:${identity.id}` || identity.corpusId !== plan.corpusId) {
        invalidResponse(`candidate response hit ${hit.id} does not match its object or corpus`);
      }
      if (actual.namespace === 'passage') {
        passages.push({ layer: 'passage', item: hit.item as Passage, similarity: hit.score });
      } else if (actual.namespace === 'fact') {
        facts.push({ layer: 'fact', item: hit.item as Fact, similarity: hit.score });
      } else {
        ontology.push({ layer: 'ontology', item: hit.item as Schema, similarity: hit.score });
      }
    }
  }
  return {
    passages,
    facts,
    ontology,
    expandedTerms: [],
    fallbackRequired: false,
    queryVector: [...plan.candidateSearch.slots[0]!.queryVector],
  };
}

function validateFactExpansionResponse(
  corpusId: string,
  plan: V15FactExpansionPlan,
  response: FactExpandBoundedResponse,
): void {
  if (!Array.isArray(response.facts) || response.facts.length > plan.limit) {
    invalidResponse('fact expansion response exceeds its result limit');
  }
  let previous: { id: string; score: number } | undefined;
  const seen = new Set<string>();
  const evaluateExpansion = compileV15FactExpansionEvaluator(plan);
  for (const hit of response.facts) {
    if (typeof hit !== 'object' || hit === null) {
      invalidResponse('fact expansion contains a malformed hit');
    }
    assertBoundedDomainObject('fact', hit.fact, `fact expansion ${hit.factId}`);
    if (hit.factId !== hit.fact.factId || hit.fact.corpusId !== corpusId || !Number.isFinite(hit.score)) {
      invalidResponse(`fact expansion hit ${hit.factId} does not match its object, corpus, or score`);
    }
    const evaluated = evaluateExpansion(hit.fact);
    if (!evaluated || evaluated.factId !== hit.factId || evaluated.score !== hit.score) {
      invalidResponse(`fact expansion hit ${hit.factId} violates the Synapse expansion policy`);
    }
    if (seen.has(hit.factId)) invalidResponse(`fact expansion contains duplicate fact ${hit.factId}`);
    seen.add(hit.factId);
    const current = { id: hit.factId, score: hit.score };
    if (previous && compareV15ScoreThenId(previous, current) >= 0) {
      invalidResponse('fact expansion response is not strictly score/id ordered');
    }
    previous = current;
  }
}

function validatePprMaterializationResponse(
  corpusId: string,
  plan: V15PprMaterializationPlan,
  response: PprMaterializeBoundedResponse,
): void {
  if (!Array.isArray(response.rankedPassages) || response.rankedPassages.length > plan.passageLimit) {
    invalidResponse('PPR passage response exceeds its result limit');
  }
  if (!Array.isArray(response.rankedFacts) || response.rankedFacts.length > plan.entityLimit) {
    invalidResponse('PPR fact response exceeds its result limit');
  }

  const validateRanking = <T extends Passage | Fact>(
    ranking: readonly { readonly nodeId: string; readonly score: number; readonly rank: number; readonly passage?: Passage; readonly fact?: Fact }[],
    namespace: 'passage' | 'fact',
  ): void => {
    let previous: { id: string; score: number } | undefined;
    const seen = new Set<string>();
    ranking.forEach((entry, index) => {
      const item = (namespace === 'passage' ? entry.passage : entry.fact) as T | undefined;
      if (!item || !Number.isFinite(entry.score) || entry.rank !== index + 1) {
        invalidResponse(`PPR ${namespace} response has an invalid score, rank, or object`);
      }
      assertBoundedDomainObject(namespace, item, `PPR ${namespace} ${entry.nodeId}`);
      const identity = objectIdentity(namespace, item);
      if (entry.nodeId !== `${namespace}:${identity.id}` || identity.corpusId !== corpusId) {
        invalidResponse(`PPR ${namespace} hit ${entry.nodeId} does not match its object or corpus`);
      }
      if (seen.has(entry.nodeId)) invalidResponse(`PPR ${namespace} response contains duplicate ${entry.nodeId}`);
      seen.add(entry.nodeId);
      const current = { id: entry.nodeId, score: entry.score };
      if (previous && compareV15ScoreThenId(previous, current) >= 0) {
        invalidResponse(`PPR ${namespace} response is not strictly score/id ordered`);
      }
      previous = current;
    });
  };

  validateRanking(response.rankedPassages, 'passage');
  validateRanking(response.rankedFacts, 'fact');
  if (
    !Number.isSafeInteger(response.iterations)
    || response.iterations < 0
    || response.iterations > plan.maxIterations
    || typeof response.converged !== 'boolean'
    || !Number.isFinite(response.l1Delta)
    || response.l1Delta < 0
    || response.converged !== (response.l1Delta < plan.convergenceEpsilon)
    || (!response.converged && response.iterations !== plan.maxIterations)
    || (response.iterations === 0 && (
      response.rankedPassages.length > 0
      || response.rankedFacts.length > 0
      || !response.converged
      || response.l1Delta !== 0
    ))
  ) {
    invalidResponse('PPR response metrics are outside the request contract');
  }
}

/**
 * One exclusive, exact-generation retrieval session.
 *
 * Every data-plane result is held locally until all requested operations and
 * final lease validation succeed.  Consequently an operation failure,
 * timeout, stale response, or transport/session loss cannot leak partial
 * context to the caller.  The acquired lease is released once in `finally`.
 */
export class BoundedGenerationSession implements GenerationSession {
  private active = false;
  private currentLease: GenerationLease | undefined;
  private heartbeatHandle: unknown;
  private heartbeatInFlight: Promise<GenerationLease> | undefined;
  private heartbeatFailure: unknown;
  private heartbeatFailureSet = false;
  private heartbeatFailureSurfaced = false;
  private renewalTail: Promise<void> = Promise.resolve();
  private readonly heartbeatIntervalMs: number;
  private readonly clock: GenerationSessionClock;

  public constructor(
    private readonly transport: GenerationSessionTransport,
    options: BoundedGenerationSessionOptions = {},
  ) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 1_000;
    if (!Number.isFinite(this.heartbeatIntervalMs) || this.heartbeatIntervalMs <= 0) {
      throw new RangeError('heartbeatIntervalMs must be a positive finite number');
    }
    this.clock = options.clock ?? SYSTEM_CLOCK;
  }

  public async run(plan: V15RetrievalRequestPlan): Promise<BoundedRetrievalResult> {
    // Policy validation deliberately precedes acquisition and every data call.
    // An unsupported profile therefore cannot trigger a native/owner request.
    assertV15RetrievalRequestPlan(plan);
    if (this.active) {
      throw new BoundedGenerationSessionError(
        'SESSION_BUSY',
        'Only one bounded GenerationSession may be active in v1',
      );
    }

    this.active = true;
    let lease: GenerationLease | undefined;
    let acquiredToken: unknown;
    let acquireResolved = false;
    let releaseAttempted = false;
    let operationError: unknown;
    let operationFailed = false;
    try {
      const acquired = await this.transport.acquireGeneration();
      // Record the owner response before validation.  A successful acquire
      // attempt must have one matching release even if the response is
      // malformed; the owner is the authority for deciding whether release
      // accepts a rejected lease token.
      acquireResolved = true;
      acquiredToken = acquired;
      lease = acquired;
      validateLease(acquired);
      this.currentLease = acquired;
      this.startHeartbeat();

      lease = await this.renew(lease);
      const candidateSearch = await this.transport.candidateSearchBounded({
        generation: lease.generation,
        corpusId: plan.corpusId,
        slots: plan.candidateSearch.slots,
      });
      validateOperationEnvelope(lease, candidateSearch, CANDIDATE_SEARCH_BOUNDED_V1);
      const candidates = validateCandidateSearchResponse(plan, candidateSearch);

      let factExpansion: FactExpandBoundedResponse | null = null;
      const factExpansionPlan = buildV15FactExpansionPlan(candidates, plan.comparisonMode);
      if (factExpansionPlan !== null) {
        validateV15FactExpansionPlan(factExpansionPlan);
        lease = await this.renew(lease);
        factExpansion = await this.transport.factExpandBounded({
          generation: lease.generation,
          corpusId: plan.corpusId,
          plan: factExpansionPlan,
        });
        validateOperationEnvelope(lease, factExpansion, FACT_EXPAND_BOUNDED_V1);
        validateFactExpansionResponse(plan.corpusId, factExpansionPlan, factExpansion);
      }

      const initialVector = buildV15InitialVector(
        candidates,
        factExpansion?.facts.map((hit) => ({ factId: hit.factId, score: hit.score })) ?? [],
      );
      const pprPlan = buildV15PprMaterializationPlan(plan.pprPolicy, initialVector);
      validateV15PprMaterializationPlan(pprPlan);
      lease = await this.renew(lease);
      const pprMaterialization = await this.transport.pprMaterializeBounded({
        generation: lease.generation,
        corpusId: plan.corpusId,
        plan: pprPlan,
      });
      validateOperationEnvelope(lease, pprMaterialization, PPR_MATERIALIZE_BOUNDED_V1);
      validatePprMaterializationResponse(plan.corpusId, pprPlan, pprMaterialization);

      // Stop scheduling and await any heartbeat first.  Only then perform the
      // one explicit final renewal/validation, so no timer renewal can race
      // after the final check and before release.
      await this.stopHeartbeat();
      lease = await this.renew(lease);
      return {
        generation: lease.generation,
        candidateSearch,
        factExpansion,
        pprMaterialization,
      };
    } catch (error) {
      operationFailed = true;
      operationError = error;
      throw error;
    } finally {
      const cleanupErrors: unknown[] = [];
      try {
        await this.stopHeartbeat();
      } catch (error) {
        cleanupErrors.push(error);
      }

      if (acquireResolved && !releaseAttempted) {
        releaseAttempted = true;
        try {
          // Keep the raw owner token for malformed successful responses.  The
          // runtime contract must release every resolved acquire exactly once;
          // a rejected acquire is the owner's atomic no-session outcome.
          await this.transport.releaseGeneration((lease ?? acquiredToken) as GenerationLease);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      this.currentLease = undefined;
      this.heartbeatFailure = undefined;
      this.heartbeatFailureSet = false;
      this.heartbeatFailureSurfaced = false;
      this.heartbeatInFlight = undefined;
      this.renewalTail = Promise.resolve();
      this.active = false;

      // Preserve the retrieval/validation/transport error when cleanup also
      // fails.  A release error is surfaced only when the retrieval itself
      // succeeded, making the policy explicit and deterministic.
      if (cleanupErrors.length > 0) {
        const cleanupError = cleanupErrors.length === 1
          ? cleanupErrors[0]
          : new AggregateError(cleanupErrors, 'Generation session cleanup failed');
        if (operationFailed) {
          throw new GenerationSessionCleanupError(operationError, cleanupError);
        }
        throw cleanupError;
      }
    }
  }

  private async renew(lease: GenerationLease): Promise<GenerationLease> {
    if (this.heartbeatFailureSet) {
      this.heartbeatFailureSurfaced = true;
      throw this.heartbeatFailure;
    }
    try {
      const renewed = await this.requestRenewal();
      validateRenewedLease(lease, renewed);
      return renewed;
    } catch (error) {
      // An explicit operation-bound renewal reports its own heartbeat error;
      // the later finally stop must not wrap that same failure a second time.
      if (this.heartbeatFailureSet) this.heartbeatFailureSurfaced = true;
      throw error;
    }
  }

  private startHeartbeat(): void {
    this.heartbeatHandle = this.clock.setInterval(() => {
      if (this.heartbeatInFlight || !this.currentLease) return;
      const renewal = this.requestRenewal();
      this.heartbeatInFlight = renewal;
      void renewal
        .catch(() => undefined)
        .finally(() => {
          if (this.heartbeatInFlight === renewal) this.heartbeatInFlight = undefined;
        });
    }, this.heartbeatIntervalMs);
  }

  private async stopHeartbeat(): Promise<void> {
    if (this.heartbeatHandle !== undefined) {
      this.clock.clearInterval(this.heartbeatHandle);
      this.heartbeatHandle = undefined;
    }
    let inFlightError: unknown;
    let inFlightFailed = false;
    if (this.heartbeatInFlight) {
      try {
        await this.heartbeatInFlight;
      } catch (error) {
        inFlightFailed = true;
        inFlightError = error;
      }
    }
    await this.renewalTail;
    const failure = inFlightFailed ? inFlightError : this.heartbeatFailure;
    if ((inFlightFailed || this.heartbeatFailureSet) && !this.heartbeatFailureSurfaced) {
      this.heartbeatFailureSurfaced = true;
      throw failure;
    }
  }

  /** Serialize explicit final validation and timer heartbeats. */
  private requestRenewal(): Promise<GenerationLease> {
    const request = this.renewalTail.then(async () => {
      if (this.heartbeatFailureSet) throw this.heartbeatFailure;
      const lease = this.currentLease;
      if (!lease) {
        throw new BoundedGenerationSessionError(
          'SESSION_MISMATCH',
          'Generation renewal requested without an active lease',
        );
      }
      const renewed = await this.transport.renewGeneration(lease);
      validateRenewedLease(lease, renewed);
      this.currentLease = renewed;
      return renewed;
    }).catch((error: unknown) => {
      this.heartbeatFailureSet = true;
      this.heartbeatFailure = error;
      throw error;
    });
    this.renewalTail = request.then(() => undefined, () => undefined);
    return request;
  }
}

export { V15_RETRIEVAL_PLAN_VERSION };
