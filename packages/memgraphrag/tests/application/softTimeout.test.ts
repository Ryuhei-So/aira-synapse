import { describe, it, expect, vi } from 'vitest';
import { executeWithSoftTimeout } from '../../src/application/query/softTimeout.js';

describe('executeWithSoftTimeout', () => {
  it('returns success when work completes before timeout', async () => {
    const result = await executeWithSoftTimeout(
      Promise.resolve(42),
      1000,
    );
    expect(result.status).toBe('success');
    expect(result.value).toBe(42);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns timeout when work exceeds timeout', async () => {
    const slowWork = new Promise<number>((resolve) => {
      setTimeout(() => resolve(42), 500);
    });
    const result = await executeWithSoftTimeout(slowWork, 50);
    expect(result.status).toBe('timeout');
    expect(result.value).toBeUndefined();
    expect(result.error).toBe('__soft_timeout__');
  });

  it('returns failure when work throws', async () => {
    const result = await executeWithSoftTimeout(
      Promise.reject(new Error('db error')),
      1000,
    );
    expect(result.status).toBe('failure');
    expect(result.error).toBe('db error');
  });

  it('calls cleanup after timeout when work settles', async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    let resolveWork: (v: number) => void;
    const work = new Promise<number>((resolve) => { resolveWork = resolve; });

    const result = await executeWithSoftTimeout(work, 50, cleanup);
    expect(result.status).toBe('timeout');
    expect(cleanup).not.toHaveBeenCalled();

    // Settle the work
    resolveWork!(42);
    await new Promise((r) => setTimeout(r, 50));
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('calls cleanup even when timed-out work fails', async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    let rejectWork: (e: Error) => void;
    const work = new Promise<number>((_, reject) => { rejectWork = reject; });

    await executeWithSoftTimeout(work, 50, cleanup);

    rejectWork!(new Error('late failure'));
    await new Promise((r) => setTimeout(r, 50));
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('does not call cleanup on non-timeout failure', async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    await executeWithSoftTimeout(
      Promise.reject(new Error('immediate error')),
      1000,
      cleanup,
    );
    expect(cleanup).not.toHaveBeenCalled();
  });
});
