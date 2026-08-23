import { describe, expect, it, vi } from 'vitest';
import type { Fact } from '../../../../src/domain/memory/fact.js';
import type { Passage } from '../../../../src/domain/memory/passage.js';
import type { QueryFeatureFlags } from '../../../../src/domain/config/featureFlags.js';
import type { FilteredMemoryCandidates, QueryRequest } from '../../../../src/domain/retrieval/memoryFilter.js';
import {
  MAX_SAFE_GENERATION,
  BoundedGenerationSession,
  BoundedGenerationSessionError,
  GenerationSessionCleanupError,
  toGeneration,
  type BoundedGenerationSessionOptions,
  type CandidateSearchBoundedResponse,
  type GenerationLease,
  type GenerationSessionClock,
  type GenerationSessionTransport,
  type PprMaterializeBoundedResponse,
} from '../../../../src/domain/retrieval/bounded.js';
import { buildV15RetrievalPlan } from '../../../../src/domain/retrieval/v15Plan.js';

const lease: GenerationLease = { generation: 42, sessionId: 'session-42' };
const flags: QueryFeatureFlags = {
  enableDictionaryInjection: false,
  enableThesaurusExpansion: false,
  enableHypernymExpansion: false,
  enableAliasHints: false,
  enableSubQueryDecomposition: false,
  enableComparisonVerification: false,
  enableMultiHopReasoning: false,
};

const fact = makeFact('fact-1');
const passage = makePassage('passage-1');

function makePlan() {
  const query: QueryRequest = {
    corpusId: 'corpus-1',
    text: 'question',
    topK: 2,
    topM: 2,
    threshold: -0.1,
    contextTokenLimit: 256,
  };
  const candidates: FilteredMemoryCandidates = {
    ontology: [],
    facts: [{ layer: 'fact', item: fact, similarity: -0.25 }],
    passages: [{ layer: 'passage', item: passage, similarity: -0.2 }],
    expandedTerms: [],
    fallbackRequired: false,
    queryVector: [1, 0],
  };
  return buildV15RetrievalPlan(
    query,
    [1, 0],
    candidates,
    { scores: { 'fact:1': -0.25, 'passage:1': 0.5 }, fallbackTriggered: false },
    {
      comparisonMode: true,
      featureFlags: flags,
      teleportProbability: 0.5,
      convergenceEpsilon: 1e-6,
      maxIterations: 100,
      hubDegreeThreshold: 50,
    },
  );
}

function candidateResponse(overrides: Partial<CandidateSearchBoundedResponse> = {}): CandidateSearchBoundedResponse {
  return {
    generation: lease.generation,
    sessionId: lease.sessionId,
    passages: [{ id: 'passage:passage-1', score: -0.2, item: passage }],
    facts: [{ id: 'fact:fact-1', score: -0.25, item: fact }],
    schemas: [],
    ...overrides,
  };
}

function pprResponse(overrides: Partial<PprMaterializeBoundedResponse> = {}): PprMaterializeBoundedResponse {
  return {
    generation: lease.generation,
    sessionId: lease.sessionId,
    rankedPassages: [{ nodeId: 'passage:passage-1', score: 0.8, rank: 1, passage }],
    rankedFacts: [{ nodeId: 'fact:fact-1', score: 0.7, rank: 1, fact }],
    iterations: 2,
    converged: true,
    l1Delta: 0,
    ...overrides,
  };
}

class ManualClock implements GenerationSessionClock {
  private readonly callbacks = new Set<() => void>();

  public setInterval(callback: () => void, _delayMs: number): unknown {
    this.callbacks.add(callback);
    return callback;
  }

  public clearInterval(handle: unknown): void {
    this.callbacks.delete(handle as () => void);
  }

  public tick(): void {
    for (const callback of [...this.callbacks]) callback();
  }
}

function transport(overrides: Partial<GenerationSessionTransport> = {}): GenerationSessionTransport {
  return {
    acquireGeneration: vi.fn().mockResolvedValue(lease),
    renewGeneration: vi.fn().mockImplementation(async (current: GenerationLease) => current),
    releaseGeneration: vi.fn().mockResolvedValue(undefined),
    candidateSearchBounded: vi.fn().mockResolvedValue(candidateResponse()),
    factExpandBounded: vi.fn().mockResolvedValue({ generation: lease.generation, sessionId: lease.sessionId, facts: [] }),
    pprMaterializeBounded: vi.fn().mockResolvedValue(pprResponse()),
    ...overrides,
  };
}

function options(clock: ManualClock): BoundedGenerationSessionOptions {
  return { heartbeatIntervalMs: 10, clock };
}

describe('BoundedGenerationSession', () => {
  it('accepts only JSON-safe generation boundaries', () => {
    expect(toGeneration(0)).toBe(0);
    expect(toGeneration(MAX_SAFE_GENERATION)).toBe(MAX_SAFE_GENERATION);
    for (const invalid of [-1, MAX_SAFE_GENERATION + 1, 1.5, Number.NaN, Infinity]) {
      expect(() => toGeneration(invalid)).toThrow(/JSON-safe integer/);
    }
  });

  it('runs all requested operations on one exact generation and releases once', async () => {
    const clock = new ManualClock();
    const owner = transport();
    const session = new BoundedGenerationSession(owner, options(clock));

    const result = await session.run(makePlan());

    expect(result.generation).toBe(42);
    expect(owner.candidateSearchBounded).toHaveBeenCalledWith(expect.objectContaining({ generation: 42, corpusId: 'corpus-1' }));
    expect(owner.factExpandBounded).toHaveBeenCalledWith(expect.objectContaining({ generation: 42 }));
    expect(owner.pprMaterializeBounded).toHaveBeenCalledWith(expect.objectContaining({ generation: 42 }));
    expect(owner.releaseGeneration).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported profile before acquire or any data-plane call', async () => {
    const clock = new ManualClock();
    const owner = transport();
    const session = new BoundedGenerationSession(owner, options(clock));
    const unsupported = { ...makePlan(), profile: 'hybrid-rrf' };

    await expect(session.run(unsupported as never)).rejects.toThrow(/Unsupported v15 retrieval profile/);
    expect(owner.acquireGeneration).not.toHaveBeenCalled();
    expect(owner.candidateSearchBounded).not.toHaveBeenCalled();
    expect(owner.releaseGeneration).not.toHaveBeenCalled();
  });

  it('discards the whole result on stale generation or session loss', async () => {
    for (const response of [
      candidateResponse({ generation: 41 }),
      candidateResponse({ sessionId: 'other-session' }),
    ]) {
      const clock = new ManualClock();
      const owner = transport({ candidateSearchBounded: vi.fn().mockResolvedValue(response) });
      const session = new BoundedGenerationSession(owner, options(clock));

      await expect(session.run(makePlan())).rejects.toThrow();
      expect(owner.pprMaterializeBounded).not.toHaveBeenCalled();
      expect(owner.releaseGeneration).toHaveBeenCalledTimes(1);
    }
  });

  it('does not expose partial context when an operation fails, including timeout/transport errors', async () => {
    for (const error of [new Error('operation timeout'), new Error('transport disconnected')]) {
      const clock = new ManualClock();
      const owner = transport({ pprMaterializeBounded: vi.fn().mockRejectedValue(error) });
      const session = new BoundedGenerationSession(owner, options(clock));

      await expect(session.run(makePlan())).rejects.toBe(error);
      expect(owner.candidateSearchBounded).toHaveBeenCalledTimes(1);
      expect(owner.releaseGeneration).toHaveBeenCalledTimes(1);
    }
  });

  it('heartbeats while a data operation is in flight and final validation waits for that renewal', async () => {
    const clock = new ManualClock();
    let resolveCandidate!: (response: CandidateSearchBoundedResponse) => void;
    const candidatePending = new Promise<CandidateSearchBoundedResponse>((resolve) => { resolveCandidate = resolve; });
    let resolveHeartbeat!: (nextLease: GenerationLease) => void;
    const heartbeatPending = new Promise<GenerationLease>((resolve) => { resolveHeartbeat = resolve; });
    let renewalCalls = 0;
    const renewGeneration = vi.fn().mockImplementation(async (current: GenerationLease) => {
      renewalCalls += 1;
      return renewalCalls === 2 ? heartbeatPending : current;
    });
    const pprMaterializeBounded = vi.fn().mockResolvedValue(pprResponse());
    const owner = transport({
      renewGeneration,
      candidateSearchBounded: vi.fn().mockReturnValue(candidatePending),
      pprMaterializeBounded,
    });
    const session = new BoundedGenerationSession(owner, options(clock));
    const run = session.run(makePlan());

    await waitFor(() => expect(owner.candidateSearchBounded).toHaveBeenCalled());
    clock.tick();
    await Promise.resolve();
    expect(renewalCalls).toBeGreaterThanOrEqual(2);

    resolveCandidate(candidateResponse());
    await Promise.resolve();
    expect(pprMaterializeBounded).not.toHaveBeenCalled();

    resolveHeartbeat(lease);
    await run;
    expect(pprMaterializeBounded).toHaveBeenCalledTimes(1);
    expect(owner.releaseGeneration).toHaveBeenCalledTimes(1);
    // Initial renewal, in-flight heartbeat, operation-bound renewal, and
    // final validation all remain serialized on one owner session.
    expect(renewalCalls).toBeGreaterThanOrEqual(4);
    const callsAfterRelease = renewalCalls;
    clock.tick();
    await Promise.resolve();
    expect(renewalCalls).toBe(callsAfterRelease);
  });

  it('reports a rejected in-flight heartbeat once before release', async () => {
    const heartbeatError = new BoundedGenerationSessionError(
      'SESSION_MISMATCH',
      'heartbeat session was replaced',
    );
    let renewalCalls = 0;
    const renewGeneration = vi.fn().mockImplementation(async (current: GenerationLease) => {
      renewalCalls += 1;
      if (renewalCalls === 3) throw heartbeatError;
      return current;
    });
    let resolvePpr!: (response: PprMaterializeBoundedResponse) => void;
    const pprPending = new Promise<PprMaterializeBoundedResponse>((resolve) => { resolvePpr = resolve; });
    const clock = new ManualClock();
    const owner = transport({
      renewGeneration,
      pprMaterializeBounded: vi.fn().mockReturnValue(pprPending),
    });
    const session = new BoundedGenerationSession(owner, options(clock));
    const run = session.run({ ...makePlan(), comparisonMode: false, factExpansion: null });

    await waitFor(() => expect(owner.pprMaterializeBounded).toHaveBeenCalled());
    clock.tick();
    await Promise.resolve();
    resolvePpr(pprResponse());

    const failure = await run.catch((error: unknown) => error) as BoundedGenerationSessionError;
    expect(failure).toBeInstanceOf(BoundedGenerationSessionError);
    expect(failure).toBe(heartbeatError);
    expect(failure.code).toBe('SESSION_MISMATCH');
    expect(owner.releaseGeneration).toHaveBeenCalledTimes(1);
  });

  it('releases once for validation, timeout, transport, and malformed-acquire failures', async () => {
    const cases: Array<{
      owner: GenerationSessionTransport;
      expected: unknown;
      releaseExpected: boolean;
    }> = [
      {
        owner: transport({ candidateSearchBounded: vi.fn().mockResolvedValue(candidateResponse({ generation: 41 })) }),
        expected: /returned generation/,
        releaseExpected: true,
      },
      {
        owner: transport({ candidateSearchBounded: vi.fn().mockRejectedValue(new Error('timeout')) }),
        expected: /timeout/,
        releaseExpected: true,
      },
      {
        owner: transport({ acquireGeneration: vi.fn().mockRejectedValue(new Error('transport')) }),
        expected: /transport/,
        releaseExpected: false,
      },
      {
        owner: transport({ acquireGeneration: vi.fn().mockResolvedValue({ generation: 42, sessionId: '' } as GenerationLease) }),
        expected: /empty generation-session/,
        releaseExpected: true,
      },
      {
        owner: transport({ acquireGeneration: vi.fn().mockResolvedValue(undefined as unknown as GenerationLease) }),
        expected: /generation must be/,
        releaseExpected: true,
      },
    ];
    for (const { owner, expected, releaseExpected } of cases) {
      const session = new BoundedGenerationSession(owner, options(new ManualClock()));
      await expect(session.run(makePlan())).rejects.toThrow(expected);
      if (releaseExpected) expect(owner.releaseGeneration).toHaveBeenCalledTimes(1);
      else expect(owner.releaseGeneration).not.toHaveBeenCalled();
    }

    const malformedOwner = transport({
      acquireGeneration: vi.fn().mockResolvedValue(undefined as unknown as GenerationLease),
    });
    await expect(new BoundedGenerationSession(malformedOwner, options(new ManualClock())).run(makePlan())).rejects.toThrow();
    expect(malformedOwner.releaseGeneration).toHaveBeenCalledWith(undefined);
  });

  it('preserves both a primary failure and a material release failure', async () => {
    const primary = new Error('native timeout');
    const release = new Error('release transport failed');
    const owner = transport({
      pprMaterializeBounded: vi.fn().mockRejectedValue(primary),
      releaseGeneration: vi.fn().mockRejectedValue(release),
    });
    const session = new BoundedGenerationSession(owner, options(new ManualClock()));

    const failure = await session.run(makePlan()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GenerationSessionCleanupError);
    expect((failure as GenerationSessionCleanupError).primaryError).toBe(primary);
    expect((failure as GenerationSessionCleanupError).cleanupError).toBe(release);
    expect(owner.releaseGeneration).toHaveBeenCalledTimes(1);
  });

  it('enforces one active v1 session', async () => {
    let resolveCandidate!: (response: CandidateSearchBoundedResponse) => void;
    const candidatePending = new Promise<CandidateSearchBoundedResponse>((resolve) => { resolveCandidate = resolve; });
    const owner = transport({ candidateSearchBounded: vi.fn().mockReturnValue(candidatePending) });
    const session = new BoundedGenerationSession(owner, options(new ManualClock()));
    const first = session.run(makePlan());
    await waitFor(() => expect(owner.candidateSearchBounded).toHaveBeenCalled());
    await expect(session.run(makePlan())).rejects.toThrow(/Only one bounded/);
    resolveCandidate(candidateResponse());
    await first;
  });
});

async function waitFor(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch {
      await Promise.resolve();
    }
  }
  assertion();
}

function makePassage(id: string): Passage {
  return {
    corpusId: 'corpus-1',
    passageId: id,
    text: 'evidence',
    normalizedText: 'evidence',
    metadata: {
      documentId: 'doc-1',
      title: 'Document',
      sourceUrl: 'https://example.com',
      language: 'en',
      sectionPath: [],
      chunkId: id,
      chunkIndex: 0,
      offsetStart: 0,
      offsetEnd: 8,
    },
    factIds: ['fact-1'],
    entityMentions: [],
    qualityFlags: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function makeFact(id: string): Fact {
  return {
    corpusId: 'corpus-1',
    factId: id,
    schemaId: 'schema-1',
    headEntity: 'Alpha',
    headType: 'Entity',
    relation: 'relates',
    tailEntity: 'Beta',
    tailType: 'Entity',
    state: 'inactive',
    passageIds: ['passage-1'],
    sourceDocumentIds: ['doc-1'],
    confidence: 0.8,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}
