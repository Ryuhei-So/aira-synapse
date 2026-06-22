/**
 * Unit tests for T5a: Race/Abort/Timeout + GuardedUsage.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GuardedUsage, raceWithAbort } from '../../../src/application/query/multiHopInfra.js';

describe('GuardedUsage', () => {
  it('should accumulate tokens before settlement', () => {
    const usage = new GuardedUsage();
    usage.add(100, 50);
    usage.add(200, 30);
    expect(usage.snapshot()).toEqual({ inputTokens: 300, outputTokens: 80 });
  });

  it('should reject mutations after settle()', () => {
    const usage = new GuardedUsage();
    usage.add(100, 50);
    usage.settle();
    usage.add(999, 999);
    expect(usage.snapshot()).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  it('should reject mutations when signal is aborted', () => {
    const controller = new AbortController();
    const usage = new GuardedUsage(controller.signal);
    usage.add(100, 50);
    controller.abort();
    usage.add(999, 999);
    expect(usage.snapshot()).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  it('should return immutable snapshot', () => {
    const usage = new GuardedUsage();
    usage.add(10, 5);
    const snap = usage.snapshot();
    usage.add(20, 10);
    // snap should not change
    expect(snap).toEqual({ inputTokens: 10, outputTokens: 5 });
  });
});

describe('raceWithAbort', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return result when pipeline completes before timeout', async () => {
    const pipeline = async (_signal: AbortSignal) => 'success';

    const promise = raceWithAbort(pipeline, 5000);
    await vi.advanceTimersByTimeAsync(0);
    const outcome = await promise;

    expect(outcome.result).toBe('success');
    expect(outcome.abortCause).toBeUndefined();
  });

  it('should return timeout cause when pipeline exceeds timeout', async () => {
    const pipeline = (_signal: AbortSignal) =>
      new Promise<string>((resolve) => setTimeout(() => resolve('late'), 10000));

    const promise = raceWithAbort(pipeline, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    const outcome = await promise;

    expect(outcome.result).toBeUndefined();
    expect(outcome.abortCause).toBe('timeout');
  });

  it('should throw when external signal fires', async () => {
    const controller = new AbortController();
    const pipeline = (_signal: AbortSignal) =>
      new Promise<string>((resolve) => setTimeout(() => resolve('late'), 10000));

    const promise = raceWithAbort(pipeline, 5000, controller.signal);

    // Abort externally — need to advance microtasks
    controller.abort();

    await expect(promise).rejects.toThrow('cancelled');
  });

  it('should throw immediately if external signal already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const pipeline = async (_signal: AbortSignal) => 'never';

    await expect(
      raceWithAbort(pipeline, 5000, controller.signal),
    ).rejects.toThrow('cancelled');
  });

  it('should pass internal signal to pipeline', async () => {
    let receivedSignal: AbortSignal | undefined;
    const pipeline = async (signal: AbortSignal) => {
      receivedSignal = signal;
      return 'done';
    };

    const promise = raceWithAbort(pipeline, 5000);
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    expect(receivedSignal).toBeDefined();
    expect(receivedSignal!.aborted).toBe(false);
  });

  it('should abort internal signal on timeout', async () => {
    let receivedSignal: AbortSignal | undefined;
    const pipeline = (signal: AbortSignal) => {
      receivedSignal = signal;
      return new Promise<string>((resolve) => setTimeout(() => resolve('late'), 10000));
    };

    const promise = raceWithAbort(pipeline, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(receivedSignal!.aborted).toBe(true);
  });

  it('should cleanup timer after successful pipeline', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const pipeline = async (_signal: AbortSignal) => 'fast';

    const promise = raceWithAbort(pipeline, 5000);
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
