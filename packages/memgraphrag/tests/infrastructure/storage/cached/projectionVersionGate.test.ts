import { describe, expect, it, vi } from 'vitest';

import type { IGraphProjection } from '../../../../src/domain/retrieval/ppr.js';
import { CachedGraphProjection } from '../../../../src/infrastructure/storage/cached/CachedGraphProjection.js';
import { syncProjectionVersion } from '../../../../src/infrastructure/storage/cached/projectionVersionGate.js';

function inner(): IGraphProjection & { loads: number } {
  const projection = {
    loads: 0,
    async *getTransitions() {
      projection.loads += 1;
      yield { sourceNodeId: 'a', targetNodeId: 'b', weight: 1 };
    },
    getDanglingNodes: vi.fn().mockResolvedValue([]),
    getNodeCount: vi.fn().mockResolvedValue(2),
  };
  return projection;
}

async function drain(projection: IGraphProjection): Promise<number> {
  let count = 0;
  for await (const _entry of projection.getTransitions('c')) count += 1;
  return count;
}

describe('syncProjectionVersion (query-entry generation gate)', () => {
  it('invalidates a cached projection exactly when the reported generation changes', async () => {
    const source = inner();
    const cached = new CachedGraphProjection(source);
    const generations = [3, 3, 4, 4];
    const readGeneration = vi.fn(async () => generations.shift()!);

    await expect(syncProjectionVersion(cached, readGeneration)).resolves.toBe(false);
    expect(await drain(cached)).toBe(1);
    await expect(syncProjectionVersion(cached, readGeneration)).resolves.toBe(false);
    expect(await drain(cached)).toBe(1);
    expect(source.loads).toBe(1);

    await expect(syncProjectionVersion(cached, readGeneration)).resolves.toBe(true);
    expect(await drain(cached)).toBe(1);
    expect(source.loads).toBe(2);
    await expect(syncProjectionVersion(cached, readGeneration)).resolves.toBe(false);
    expect(source.loads).toBe(2);
    expect(readGeneration).toHaveBeenCalledTimes(4);
  });

  it('is a no-op without a generation source or for an uncached projection', async () => {
    const source = inner();
    const readGeneration = vi.fn(async () => 1);
    await expect(syncProjectionVersion(new CachedGraphProjection(source), undefined)).resolves.toBe(false);
    await expect(syncProjectionVersion(source, readGeneration)).resolves.toBe(false);
    expect(readGeneration).not.toHaveBeenCalled();
  });

  it('fails closed on an invalid generation instead of caching under it', async () => {
    const cached = new CachedGraphProjection(inner());
    await expect(syncProjectionVersion(cached, async () => -1)).rejects.toThrow('store generation must be a nonnegative safe integer');
    await expect(syncProjectionVersion(cached, async () => Number.NaN)).rejects.toThrow('store generation must be a nonnegative safe integer');
    expect(cached.observedVersion).toBeUndefined();
  });
});
