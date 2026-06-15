import { describe, it, expect, vi } from 'vitest';
import { CachedMemoryStore } from '../../../../src/infrastructure/storage/cached/CachedMemoryStore.js';
import { CachedGraphProjection } from '../../../../src/infrastructure/storage/cached/CachedGraphProjection.js';
import type { IMemoryStore, JobCheckpoint } from '../../../../src/domain/storage/graphStore.js';
import type { MemorySnapshot } from '../../../../src/domain/memory/globalMemory.js';
import type { IGraphProjection, TransitionEntry } from '../../../../src/domain/retrieval/ppr.js';

// --- CachedMemoryStore ---

function createMockMemoryStore(snapshot: MemorySnapshot): IMemoryStore {
  return {
    load: vi.fn().mockResolvedValue(snapshot),
    save: vi.fn().mockResolvedValue(undefined),
    saveCheckpoint: vi.fn().mockResolvedValue(undefined),
    loadCheckpoint: vi.fn().mockResolvedValue(null),
    validateIntegrity: vi.fn().mockResolvedValue([]),
  };
}

const DUMMY_SNAPSHOT: MemorySnapshot = {
  corpusId: 'test-corpus',
  schemas: [],
  facts: [],
  passages: [],
};

describe('CachedMemoryStore', () => {
  it('loads from inner on first call', async () => {
    const inner = createMockMemoryStore(DUMMY_SNAPSHOT);
    const cached = new CachedMemoryStore(inner);

    const result = await cached.load('test-corpus');

    expect(result).toBe(DUMMY_SNAPSHOT);
    expect(inner.load).toHaveBeenCalledTimes(1);
  });

  it('returns cached snapshot on subsequent calls', async () => {
    const inner = createMockMemoryStore(DUMMY_SNAPSHOT);
    const cached = new CachedMemoryStore(inner);

    await cached.load('test-corpus');
    await cached.load('test-corpus');
    await cached.load('test-corpus');

    expect(inner.load).toHaveBeenCalledTimes(1);
  });

  it('reloads after save() invalidates cache', async () => {
    const inner = createMockMemoryStore(DUMMY_SNAPSHOT);
    const cached = new CachedMemoryStore(inner);

    await cached.load('test-corpus');
    await cached.save(DUMMY_SNAPSHOT);
    await cached.load('test-corpus');

    expect(inner.load).toHaveBeenCalledTimes(2);
  });

  it('reloads after invalidate()', async () => {
    const inner = createMockMemoryStore(DUMMY_SNAPSHOT);
    const cached = new CachedMemoryStore(inner);

    await cached.load('test-corpus');
    cached.invalidate();
    await cached.load('test-corpus');

    expect(inner.load).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent loads', async () => {
    const inner = createMockMemoryStore(DUMMY_SNAPSHOT);
    const cached = new CachedMemoryStore(inner);

    const [r1, r2, r3] = await Promise.all([
      cached.load('test-corpus'),
      cached.load('test-corpus'),
      cached.load('test-corpus'),
    ]);

    expect(r1).toBe(DUMMY_SNAPSHOT);
    expect(r2).toBe(DUMMY_SNAPSHOT);
    expect(r3).toBe(DUMMY_SNAPSHOT);
    expect(inner.load).toHaveBeenCalledTimes(1);
  });

  it('delegates checkpoint methods to inner', async () => {
    const inner = createMockMemoryStore(DUMMY_SNAPSHOT);
    const cached = new CachedMemoryStore(inner);
    const cp: JobCheckpoint = { jobId: 'j1', corpusId: 'c1', processedDocumentIds: [], updatedAt: '' };

    await cached.saveCheckpoint(cp);
    await cached.loadCheckpoint('j1');
    await cached.validateIntegrity('c1');

    expect(inner.saveCheckpoint).toHaveBeenCalledWith(cp);
    expect(inner.loadCheckpoint).toHaveBeenCalledWith('j1');
    expect(inner.validateIntegrity).toHaveBeenCalledWith('c1');
  });
});

// --- CachedGraphProjection ---

function createMockProjection(entries: TransitionEntry[]): IGraphProjection {
  return {
    getTransitions: vi.fn(async function* () {
      for (const e of entries) yield e;
    }),
    getDanglingNodes: vi.fn().mockResolvedValue([]),
    getNodeCount: vi.fn().mockResolvedValue(entries.length),
  };
}

const DUMMY_TRANSITIONS: TransitionEntry[] = [
  { sourceNodeId: 'a', targetNodeId: 'b', weight: 1.0 },
  { sourceNodeId: 'b', targetNodeId: 'c', weight: 0.5 },
  { sourceNodeId: 'c', targetNodeId: 'a', weight: 0.3 },
];

describe('CachedGraphProjection', () => {
  it('loads transitions from inner on first call', async () => {
    const inner = createMockProjection(DUMMY_TRANSITIONS);
    const cached = new CachedGraphProjection(inner);

    const results: TransitionEntry[] = [];
    for await (const e of cached.getTransitions('corpus1')) {
      results.push(e);
    }

    expect(results).toEqual(DUMMY_TRANSITIONS);
    expect(inner.getTransitions).toHaveBeenCalledTimes(1);
  });

  it('serves from cache on subsequent calls', async () => {
    const inner = createMockProjection(DUMMY_TRANSITIONS);
    const cached = new CachedGraphProjection(inner);

    for await (const _ of cached.getTransitions('corpus1')) { /* drain */ }
    const results: TransitionEntry[] = [];
    for await (const e of cached.getTransitions('corpus1')) {
      results.push(e);
    }

    expect(results).toEqual(DUMMY_TRANSITIONS);
    expect(inner.getTransitions).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent loads', async () => {
    const inner = createMockProjection(DUMMY_TRANSITIONS);
    const cached = new CachedGraphProjection(inner);

    async function drain(corpusId: string) {
      const r: TransitionEntry[] = [];
      for await (const e of cached.getTransitions(corpusId)) r.push(e);
      return r;
    }

    const [r1, r2] = await Promise.all([drain('corpus1'), drain('corpus1')]);

    expect(r1).toEqual(DUMMY_TRANSITIONS);
    expect(r2).toEqual(DUMMY_TRANSITIONS);
    expect(inner.getTransitions).toHaveBeenCalledTimes(1);
  });

  it('reloads after invalidate()', async () => {
    const inner = createMockProjection(DUMMY_TRANSITIONS);
    const cached = new CachedGraphProjection(inner);

    for await (const _ of cached.getTransitions('corpus1')) { /* drain */ }
    cached.invalidate();
    for await (const _ of cached.getTransitions('corpus1')) { /* drain */ }

    expect(inner.getTransitions).toHaveBeenCalledTimes(2);
  });

  it('delegates getDanglingNodes and getNodeCount to inner', async () => {
    const inner = createMockProjection(DUMMY_TRANSITIONS);
    const cached = new CachedGraphProjection(inner);

    await cached.getDanglingNodes('corpus1');
    await cached.getNodeCount('corpus1');

    expect(inner.getDanglingNodes).toHaveBeenCalledWith('corpus1');
    expect(inner.getNodeCount).toHaveBeenCalledWith('corpus1');
  });
});
