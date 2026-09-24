/**
 * literature-hub #594 deliverable 1: swap-on-success for the cached ranking
 * graph. A failed reload after a generation change keeps serving the last
 * successfully loaded projection, logs `projection_stale`, and retries with a
 * bounded backoff; only a successful reload replaces it; with nothing loaded
 * yet, a failed load still fails the call.
 */
import { describe, expect, it, vi } from 'vitest';

import type { IGraphProjection, TransitionEntry } from '../../../../src/domain/retrieval/ppr.js';
import {
  CachedGraphProjection,
  ProjectionUnavailableError,
  type ProjectionCacheEvent,
} from '../../../../src/infrastructure/storage/cached/CachedGraphProjection.js';

class OverflowError extends Error {
  public readonly code = 'NATIVE_LINE_OVERFLOW';
  public constructor() {
    super('native graphdb reply exceeds the owner line bound: secret-ish payload detail');
  }
}

/** An inner projection whose next loads can be scripted to fail or to return a new graph. */
function scripted(initial: string) {
  const state = {
    loads: 0,
    label: initial,
    fail: null as (() => unknown) | null,
  };
  const projection: IGraphProjection = {
    async *getTransitions() {
      state.loads += 1;
      if (state.fail) throw state.fail();
      yield { sourceNodeId: state.label, targetNodeId: 'x', weight: 1 };
    },
    getDanglingNodes: vi.fn().mockResolvedValue([]),
    getNodeCount: vi.fn().mockResolvedValue(2),
  };
  return { state, projection };
}

async function label(projection: IGraphProjection, corpusId = 'c'): Promise<string> {
  const out: TransitionEntry[] = [];
  for await (const entry of projection.getTransitions(corpusId)) out.push(entry);
  return out[0]!.sourceNodeId;
}

function harness(initial = 'g1') {
  const { state, projection } = scripted(initial);
  const events: ProjectionCacheEvent[] = [];
  let clock = 1_000_000;
  const cached = new CachedGraphProjection(projection, {
    onEvent: (event) => events.push(event),
    reloadBackoff: { initialMs: 1_000, maxMs: 4_000 },
    coldBackoff: { initialMs: 500, maxMs: 1_000 },
    now: () => clock,
  });
  return {
    state,
    events,
    cached,
    advance: (ms: number) => { clock += ms; },
    stale: () => events.filter((event) => event.event === 'projection_stale'),
  };
}

describe('CachedGraphProjection swap-on-success (literature-hub #594)', () => {
  it('serves the last loaded projection when the reload after a generation bump fails, and logs the staleness', async () => {
    const h = harness();
    h.cached.invalidateIfVersionChanged(1278);
    expect(await label(h.cached)).toBe('g1');
    const snapshot = await h.cached.getTransitionSnapshot('c');

    h.state.label = 'g2';
    h.state.fail = () => new OverflowError();
    expect(h.cached.invalidateIfVersionChanged(1279)).toBe(true);
    expect(await label(h.cached)).toBe('g1');
    expect(h.state.loads).toBe(2);
    // The stale snapshot keeps its identity, so the compiled PPR graph is reused.
    expect(await h.cached.getTransitionSnapshot('c')).toBe(snapshot);
    expect(h.cached.servedProjection).toEqual({ corpusId: 'c', version: 1278, stale: true });

    expect(h.stale()[0]).toEqual({
      event: 'projection_stale',
      corpusId: 'c',
      entries: 1,
      servedVersion: 1278,
      currentVersion: 1279,
      failureClass: 'NATIVE_LINE_OVERFLOW',
      reloadAttempted: true,
      reason: 'reload_failed',
      consecutiveFailures: 1,
      nextRetryInMs: 1_000,
    });
    // The error message never reaches the log.
    expect(JSON.stringify(h.events)).not.toContain('secret-ish');
  });

  it('retries on later calls with bounded exponential backoff, serving stale in between', async () => {
    const h = harness();
    h.cached.invalidateIfVersionChanged(1);
    await label(h.cached);
    h.state.fail = () => new OverflowError();
    h.cached.invalidateIfVersionChanged(2);

    const attempts: number[] = [];
    const record = async () => {
      const before = h.state.loads;
      expect(await label(h.cached)).toBe('g1');
      attempts.push(h.state.loads - before);
    };
    await record(); // attempt 1 fails -> wait 1s
    await record(); // inside window
    h.advance(999);
    await record(); // still inside window
    h.advance(1);
    await record(); // attempt 2 fails -> wait 2s
    h.advance(2_000);
    await record(); // attempt 3 fails -> wait 4s
    h.advance(4_000);
    await record(); // attempt 4 fails -> capped at 4s
    h.advance(3_999);
    await record(); // inside the capped window
    expect(attempts).toEqual([1, 0, 0, 1, 1, 1, 0]);

    const stale = h.stale();
    expect(stale.map((event) => event.event === 'projection_stale' && event.reloadAttempted))
      .toEqual([true, false, false, true, true, true, false]);
    expect(stale.map((event) => event.event === 'projection_stale' && event.reason))
      .toEqual(['reload_failed', 'backoff', 'backoff', 'reload_failed', 'reload_failed', 'reload_failed', 'backoff']);
    expect(stale.map((event) => event.event === 'projection_stale' && event.nextRetryInMs))
      .toEqual([1_000, 1_000, 1, 2_000, 4_000, 4_000, 1]);
    expect(stale.every((event) => event.event === 'projection_stale'
      && event.failureClass === 'NATIVE_LINE_OVERFLOW' && event.servedVersion === 1 && event.currentVersion === 2)).toBe(true);

    // Further generation bumps do not reset the backoff (the index worker commits every few minutes).
    h.cached.invalidateIfVersionChanged(3);
    await record();
    expect(attempts.at(-1)).toBe(0);
  });

  it('swaps to the reloaded projection only when the reload succeeds, and resets the backoff', async () => {
    const h = harness();
    h.cached.invalidateIfVersionChanged(1);
    await label(h.cached);
    h.state.fail = () => new OverflowError();
    h.cached.invalidateIfVersionChanged(2);
    expect(await label(h.cached)).toBe('g1');

    h.state.fail = null;
    h.state.label = 'g3';
    h.cached.invalidateIfVersionChanged(3);
    // Still inside the backoff window: no reload even though the native would now succeed.
    expect(await label(h.cached)).toBe('g1');
    h.advance(1_000);
    expect(await label(h.cached)).toBe('g3');
    expect(h.cached.servedProjection).toEqual({ corpusId: 'c', version: 3, stale: false });
    expect(h.events.at(-1)).toMatchObject({ event: 'graph_projection_cache_loaded', version: 3 });

    // Backoff reset: the next failure starts again at the initial delay.
    h.state.fail = () => new OverflowError();
    h.cached.invalidateIfVersionChanged(4);
    expect(await label(h.cached)).toBe('g3');
    expect(h.stale().at(-1)).toMatchObject({ consecutiveFailures: 1, nextRetryInMs: 1_000, servedVersion: 3, currentVersion: 4 });
  });

  it('fails closed when the first load fails, then fails fast inside the shorter cold window (#27 M1, #28 M1/M2)', async () => {
    const h = harness();
    const unavailable = () => h.events.filter((event) => event.event === 'projection_unavailable');
    h.state.fail = () => new OverflowError();
    h.cached.invalidateIfVersionChanged(1279);
    await expect(label(h.cached)).rejects.toMatchObject({ code: 'NATIVE_LINE_OVERFLOW' });
    expect(unavailable()).toEqual([{
      event: 'projection_unavailable',
      corpusId: 'c',
      currentVersion: 1279,
      failureClass: 'NATIVE_LINE_OVERFLOW',
      loadAttempted: true,
      fastFailedCalls: 0,
      consecutiveFailures: 1,
      nextRetryInMs: 500,
    }]);

    // Inside the cold window: no corpus-sized read, a fast PROJECTION_UNAVAILABLE instead,
    // and only the first fast-fail of the window is logged.
    h.advance(499);
    await expect(label(h.cached)).rejects.toBeInstanceOf(ProjectionUnavailableError);
    await expect(label(h.cached)).rejects.toMatchObject({
      code: 'PROJECTION_UNAVAILABLE', failureClass: 'NATIVE_LINE_OVERFLOW', nextRetryInMs: 1,
    });
    h.cached.invalidateIfVersionChanged(1280);
    await expect(label(h.cached)).rejects.toMatchObject({ code: 'PROJECTION_UNAVAILABLE' });
    expect(h.state.loads).toBe(1);
    expect(unavailable()).toHaveLength(2);
    expect(unavailable()[1]).toMatchObject({ loadAttempted: false, fastFailedCalls: 1, consecutiveFailures: 1 });

    // After the window the load is retried; its event carries the suppressed fast-fails.
    h.advance(1);
    await expect(label(h.cached)).rejects.toMatchObject({ code: 'NATIVE_LINE_OVERFLOW' });
    expect(h.state.loads).toBe(2);
    expect(unavailable().at(-1)).toMatchObject({ loadAttempted: true, fastFailedCalls: 3, consecutiveFailures: 2, nextRetryInMs: 1_000 });

    // The cold cap holds however many loads fail (the warm cap would reach 4 s here).
    for (let attempt = 3; attempt <= 5; attempt += 1) {
      h.advance(1_000);
      await expect(label(h.cached)).rejects.toMatchObject({ code: 'NATIVE_LINE_OVERFLOW' });
      expect(unavailable().at(-1)).toMatchObject({ loadAttempted: true, consecutiveFailures: attempt, nextRetryInMs: 1_000 });
    }

    // Once the native can serve, the first load after the window succeeds and clears the failures.
    h.state.fail = null;
    h.advance(1_000);
    expect(await label(h.cached)).toBe('g1');
    expect(h.cached.servedProjection).toEqual({ corpusId: 'c', version: 1280, stale: false });
    expect(h.stale()).toEqual([]);
  });

  it('defaults the cold window to 60 s capped at 2 min, and validates backoff options', async () => {
    const { state, projection } = scripted('g1');
    const events: ProjectionCacheEvent[] = [];
    let clock = 0;
    const cached = new CachedGraphProjection(projection, { onEvent: (event) => events.push(event), now: () => clock });
    state.fail = () => new OverflowError();
    const delays: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(label(cached)).rejects.toMatchObject({ code: 'NATIVE_LINE_OVERFLOW' });
      const last = events.at(-1)!;
      delays.push(last.event === 'projection_unavailable' ? last.nextRetryInMs : -1);
      clock += delays.at(-1)!;
    }
    expect(delays).toEqual([60_000, 120_000, 120_000, 120_000]);
    expect(() => new CachedGraphProjection(projection, { coldBackoff: { initialMs: 10, maxMs: 5 } })).toThrow('coldBackoff');
    expect(() => new CachedGraphProjection(projection, { reloadBackoff: { initialMs: -1, maxMs: 5 } })).toThrow('reloadBackoff');
  });

  it('a cold failure of one corpus does not back off another corpus', async () => {
    const h = harness();
    h.state.fail = () => new OverflowError();
    await expect(label(h.cached, 'a')).rejects.toMatchObject({ code: 'NATIVE_LINE_OVERFLOW' });
    h.state.fail = null;
    expect(await label(h.cached, 'b')).toBe('g1');
  });

  it('keeps serving a projection younger than minReloadIntervalMs after a version change', async () => {
    const { state, projection } = scripted('g1');
    const events: ProjectionCacheEvent[] = [];
    let clock = 0;
    const cached = new CachedGraphProjection(projection, {
      onEvent: (event) => events.push(event),
      minReloadIntervalMs: 5_000,
      now: () => clock,
    });
    cached.invalidateIfVersionChanged(1);
    expect(await label(cached)).toBe('g1');
    state.label = 'g2';
    cached.invalidateIfVersionChanged(2);
    clock = 4_999;
    expect(await label(cached)).toBe('g1');
    expect(state.loads).toBe(1);
    expect(events.at(-1)).toMatchObject({
      event: 'projection_stale', reason: 'min_reload_interval', reloadAttempted: false,
      failureClass: 'NONE', servedVersion: 1, currentVersion: 2, consecutiveFailures: 0,
    });
    clock = 5_000;
    expect(await label(cached)).toBe('g2');
    expect(state.loads).toBe(2);
    expect(() => new CachedGraphProjection(projection, { minReloadIntervalMs: -1 })).toThrow('minReloadIntervalMs');
  });

  it('a stale projection of another corpus is never served for this one', async () => {
    const h = harness();
    await label(h.cached, 'a');
    h.state.fail = () => new OverflowError();
    await expect(label(h.cached, 'b')).rejects.toMatchObject({ code: 'NATIVE_LINE_OVERFLOW' });
    expect(h.stale()).toEqual([]);
  });

  it('an explicit invalidate() drops the served projection outright and forgets failed loads', async () => {
    const h = harness();
    await label(h.cached);
    h.cached.invalidate();
    h.state.fail = () => new OverflowError();
    await expect(label(h.cached)).rejects.toMatchObject({ code: 'NATIVE_LINE_OVERFLOW' });
    h.cached.invalidate();
    await expect(label(h.cached)).rejects.toMatchObject({ code: 'NATIVE_LINE_OVERFLOW' });
    expect(h.state.loads).toBe(3);
  });

  it('classifies an error without a constant-style code as UNCLASSIFIED', async () => {
    const h = harness();
    h.cached.invalidateIfVersionChanged(1);
    await label(h.cached);
    h.state.fail = () => Object.assign(new Error('boom'), { code: 'not a class; with data' });
    h.cached.invalidateIfVersionChanged(2);
    expect(await label(h.cached)).toBe('g1');
    expect(h.stale()[0]).toMatchObject({ failureClass: 'UNCLASSIFIED' });
  });

  it('concurrent callers share one failing reload and both get the stale projection', async () => {
    const h = harness();
    h.cached.invalidateIfVersionChanged(1);
    await label(h.cached);
    h.state.fail = () => new OverflowError();
    h.cached.invalidateIfVersionChanged(2);
    const [left, right] = await Promise.all([label(h.cached), label(h.cached)]);
    expect([left, right]).toEqual(['g1', 'g1']);
    expect(h.state.loads).toBe(2);
    expect(h.stale()).toHaveLength(1);
  });

  it('a synchronously throwing inner projection does not wedge the load slot', async () => {
    let calls = 0;
    const inner: IGraphProjection = {
      getTransitions(): AsyncIterable<TransitionEntry> {
        calls += 1;
        throw new OverflowError();
      },
      getDanglingNodes: vi.fn().mockResolvedValue([]),
      getNodeCount: vi.fn().mockResolvedValue(0),
    };
    const cached = new CachedGraphProjection(inner, {
      reloadBackoff: { initialMs: 0, maxMs: 0 },
      coldBackoff: { initialMs: 0, maxMs: 0 },
    });
    await expect(label(cached)).rejects.toMatchObject({ code: 'NATIVE_LINE_OVERFLOW' });
    await expect(label(cached)).rejects.toMatchObject({ code: 'NATIVE_LINE_OVERFLOW' });
    expect(calls).toBe(2);
  });

  it('a projection loaded before the first version observation is adopted under it, not reloaded', async () => {
    const h = harness();
    await label(h.cached);
    expect(h.cached.invalidateIfVersionChanged(7)).toBe(false);
    expect(h.cached.servedProjection).toEqual({ corpusId: 'c', version: 7, stale: false });
    await label(h.cached);
    expect(h.state.loads).toBe(1);
  });
});
