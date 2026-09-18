import { describe, expect, it, vi } from 'vitest';
import { SimplePPR } from '../../../../src/application/query/SimplePPR.js';
import { CachedGraphProjection } from '../../../../src/infrastructure/storage/cached/CachedGraphProjection.js';
import type { IGraphProjection, PPRRequest, TransitionEntry } from '../../../../src/domain/retrieval/ppr.js';

async function* stream(entries: readonly TransitionEntry[]): AsyncIterable<TransitionEntry> {
  for (const entry of entries) yield entry;
}

/** A projection without a snapshot: SimplePPR must fall back to streaming every call. */
function streamingProjection(entries: readonly TransitionEntry[]): IGraphProjection {
  return { getTransitions: () => stream(entries), getDanglingNodes: vi.fn(), getNodeCount: vi.fn() };
}

/** Deterministic pseudo-random graph with passages, facts, entities and one schema hub. */
function syntheticGraph(seed: number, nodes = 400, edges = 3000): TransitionEntry[] {
  let state = seed >>> 0;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const ids: string[] = [];
  for (let i = 0; i < nodes; i++) {
    const layer = i % 4 === 0 ? 'passage' : i % 4 === 1 ? 'fact' : i % 4 === 2 ? 'entity' : 'schema';
    ids.push(`${layer}:${i}`);
  }
  const entries: TransitionEntry[] = [];
  for (let i = 0; i < edges; i++) {
    const source = ids[Math.floor(next() * nodes)]!;
    // Every 5th edge points at the hub so it exceeds the hub-degree threshold.
    const target = i % 5 === 0 ? 'schema:3' : ids[Math.floor(next() * nodes)]!;
    if (source === target) continue;
    entries.push({ sourceNodeId: source, targetNodeId: target, weight: 0.25 + next() });
  }
  return entries;
}

const baseRequest: PPRRequest = {
  corpusId: 'c1',
  initialVector: { scores: { 'passage:0': 0.7, 'entity:6': 0.3, 'fact:9': 0.2 }, fallbackTriggered: false },
  teleportProbability: 0.5,
  convergenceEpsilon: 1e-6,
  maxIterations: 50,
  hubDegreeThreshold: 20,
  topK: 25,
  topM: 25,
};

describe('SimplePPR compiled graph cache', () => {
  it('produces bit-identical rankings with and without a transition snapshot', async () => {
    const entries = syntheticGraph(7);
    const cached = new CachedGraphProjection(streamingProjection(entries));
    const streamed = await new SimplePPR().run(baseRequest, streamingProjection(entries));
    const compiled = await new SimplePPR().run(baseRequest, cached);
    expect(compiled).toEqual(streamed);
    // Exact float equality, not closeTo: the arithmetic order is part of the contract.
    expect(compiled.rankedPassages.map((node) => node.score)).toStrictEqual(streamed.rankedPassages.map((node) => node.score));
    expect(compiled.rankedEntities.map((node) => node.score)).toStrictEqual(streamed.rankedEntities.map((node) => node.score));
    expect(compiled.l1Delta).toBe(streamed.l1Delta);
    expect(compiled.iterations).toBe(streamed.iterations);
    expect(compiled.converged).toBe(true);
  });

  it('compiles once per snapshot and threshold, and recompiles only after the projection invalidates', async () => {
    const entries = syntheticGraph(11);
    const inner = streamingProjection(entries);
    const getTransitions = vi.spyOn(inner, 'getTransitions');
    const cached = new CachedGraphProjection(inner);
    const ppr = new SimplePPR();

    const first = await ppr.run(baseRequest, cached);
    const second = await ppr.run({ ...baseRequest, initialVector: { scores: { 'fact:1': 1 }, fallbackTriggered: false } }, cached);
    expect(ppr.compilations).toBe(1);
    expect(getTransitions).toHaveBeenCalledTimes(1);
    expect(second).not.toEqual(first);

    // A different hub threshold changes damping, so it is a different compiled graph.
    await ppr.run({ ...baseRequest, hubDegreeThreshold: 5 }, cached);
    expect(ppr.compilations).toBe(2);
    expect(getTransitions).toHaveBeenCalledTimes(1);

    // Invalidation hands out a new snapshot array: the compiled graph must not survive it.
    cached.invalidate();
    const afterInvalidate = await ppr.run(baseRequest, cached);
    expect(ppr.compilations).toBe(3);
    expect(getTransitions).toHaveBeenCalledTimes(2);
    expect(afterInvalidate).toEqual(first);
  });

  it('does not serve a stale graph after the projection reloads different transitions', async () => {
    let entries = syntheticGraph(3);
    const inner: IGraphProjection = { getTransitions: () => stream(entries), getDanglingNodes: vi.fn(), getNodeCount: vi.fn() };
    const cached = new CachedGraphProjection(inner);
    const ppr = new SimplePPR();
    const before = await ppr.run(baseRequest, cached);

    entries = syntheticGraph(4);
    cached.invalidateIfVersionChanged(1);
    cached.invalidateIfVersionChanged(2);
    const after = await ppr.run(baseRequest, cached);
    expect(after).not.toEqual(before);
    expect(after).toEqual(await new SimplePPR().run(baseRequest, streamingProjection(entries)));
  });

  it('streams every call for a projection without a snapshot', async () => {
    const entries = syntheticGraph(5);
    const inner = streamingProjection(entries);
    const getTransitions = vi.spyOn(inner, 'getTransitions');
    const ppr = new SimplePPR();
    await ppr.run(baseRequest, inner);
    await ppr.run(baseRequest, inner);
    expect(getTransitions).toHaveBeenCalledTimes(2);
    expect(ppr.compilations).toBe(2);
  });
});
