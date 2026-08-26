import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  clients: [] as Array<{
    close: ReturnType<typeof vi.fn>;
    request: ReturnType<typeof vi.fn>;
  }>,
  indexingCreate: vi.fn(),
  termination: Object.freeze({ kind: 'graceful_reaped' }) as Readonly<Record<string, unknown>>,
}));

vi.mock('../../../../../src/infrastructure/storage/aira-graphdb/NativeClient.js', () => {
  class FakeNativeClient {
    public readonly request = vi.fn();
    public readonly receipt: Promise<Readonly<Record<string, unknown>>>;
    public readonly close: ReturnType<typeof vi.fn>;

    public constructor() {
      let resolveReceipt!: (result: Readonly<Record<string, unknown>>) => void;
      this.receipt = new Promise((resolve) => { resolveReceipt = resolve; });
      const closePromise = this.receipt.then((result) => {
        if (result.kind === 'termination_failed') throw new Error('fixed termination failure');
      });
      void closePromise.catch(() => undefined);
      this.close = vi.fn(() => {
        resolveReceipt(state.termination);
        return closePromise;
      });
      state.clients.push(this);
    }
  }

  return {
    AiraGraphDbNativeClient: FakeNativeClient,
    readAiraGraphDbNativeTerminationReceipt: (client: FakeNativeClient) => client.receipt,
  };
});

vi.mock('../../../../../src/infrastructure/storage/aira-graphdb/AiraGraphDbIndexingMemory.js', () => ({
  AiraGraphDbIndexingMemory: { create: state.indexingCreate },
}));

vi.mock('../../../../../src/infrastructure/storage/aira-graphdb/AiraGraphDbAdapters.js', () => ({
  AiraGraphDbGraphStore: class {},
  AiraGraphDbVectorIndex: class {},
  AiraGraphDbMemoryStore: class {},
  AiraGraphDbGraphProjection: class {},
  AiraGraphDbLexicalRetriever: class {},
}));

import {
  createAiraGraphDbAdapters,
  readAiraGraphDbAdapterTerminationReceipt,
} from '../../../../../src/infrastructure/storage/ladybug/storageFactory.js';

function frozenTermination(
  result:
    | { kind: 'graceful_reaped' }
    | {
        kind: 'unexpected_reaped';
        reason: 'protocol_poison';
        lastSignal: null;
      }
    | {
        kind: 'termination_failed';
        reason: 'explicit_close';
        missing: 'exit';
        lastSignal: 'SIGKILL';
      },
): Readonly<Record<string, unknown>> {
  return Object.freeze(result);
}

beforeEach(() => {
  state.clients.length = 0;
  state.indexingCreate.mockReset();
  state.indexingCreate.mockResolvedValue({ indexing: true });
  state.termination = frozenTermination({ kind: 'graceful_reaped' });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe.sequential('Aira GraphDB storage factory termination propagation', () => {
  it('registers only the exact returned object and shares one close function/completion', async () => {
    const adapters = await createAiraGraphDbAdapters({ dbPath: '/private/graphdb.agdb' });
    const client = state.clients[0]!;

    expect(Reflect.ownKeys(adapters)).toEqual([
      'batch',
      'graphStore',
      'vectorIndex',
      'memoryStore',
      'indexingMemory',
      'graphProjection',
      'lexicalRetriever',
      'close',
    ]);
    expect(Reflect.ownKeys(adapters.batch!)).toEqual(['begin', 'commit', 'abandon']);
    expect(adapters.close).toBe(adapters.batch!.abandon);

    const receipt = readAiraGraphDbAdapterTerminationReceipt(adapters);
    expect(receipt).toBeDefined();
    expect(readAiraGraphDbAdapterTerminationReceipt({ ...adapters })).toBeUndefined();
    expect(readAiraGraphDbAdapterTerminationReceipt(new Proxy(adapters, {}))).toBeUndefined();
    expect(readAiraGraphDbAdapterTerminationReceipt({})).toBeUndefined();
    expect(readAiraGraphDbAdapterTerminationReceipt(null)).toBeUndefined();

    const close = adapters.close();
    const abandon = adapters.batch!.abandon();
    expect(close).toBe(abandon);
    await expect(close).resolves.toBeUndefined();
    await expect(receipt).resolves.toEqual({ kind: 'graceful_reaped' });
    expect(client.close).toHaveBeenCalledTimes(2);
  });

  it('keeps begin and commit RPC behavior unchanged', async () => {
    const adapters = await createAiraGraphDbAdapters({ dbPath: '/private/graphdb.agdb' });
    const client = state.clients[0]!;

    await adapters.batch!.begin();
    await adapters.batch!.commit();

    expect(client.request.mock.calls).toEqual([
      ['batch_begin', {}],
      ['batch_commit', {}],
    ]);
    await adapters.close();
  });

  it('rethrows the exact acquisition error after a graceful direct-child reap', async () => {
    const primary = new Error('/private/primary-secret');
    state.indexingCreate.mockRejectedValueOnce(primary);

    const thrown = await createAiraGraphDbAdapters({ dbPath: '/private/graphdb.agdb' })
      .catch((error: unknown) => error);

    expect(thrown).toBe(primary);
    expect(state.clients[0]!.close).toHaveBeenCalledTimes(1);
  });

  it.each([
    frozenTermination({
      kind: 'unexpected_reaped',
      reason: 'protocol_poison',
      lastSignal: null,
    }),
    frozenTermination({
      kind: 'termination_failed',
      reason: 'explicit_close',
      missing: 'exit',
      lastSignal: 'SIGKILL',
    }),
  ])('replaces raw acquisition/cleanup failures with one safe error for $kind', async (termination) => {
    state.termination = termination;
    state.indexingCreate.mockRejectedValueOnce(new Error('/private/primary-secret'));

    const thrown = await createAiraGraphDbAdapters({ dbPath: '/private/graphdb.agdb' })
      .catch((error: unknown) => error) as Error & {
        code: string;
        termination: Readonly<Record<string, unknown>>;
      };

    expect(Reflect.ownKeys(thrown).sort()).toEqual([
      'code',
      'message',
      'name',
      'stack',
      'termination',
    ]);
    expect(thrown).toMatchObject({
      name: 'AiraGraphDbAcquisitionCleanupError',
      code: 'AIRA_GRAPHDB_ACQUISITION_CLEANUP_FAILED',
      message: 'aira-graphdb adapter acquisition cleanup failed',
      stack: 'AiraGraphDbAcquisitionCleanupError: aira-graphdb adapter acquisition cleanup failed',
      termination,
    });
    expect(thrown.termination).toBe(termination);
    expect(Object.isFrozen(thrown)).toBe(true);
    expect('cause' in thrown).toBe(false);
    expect('errors' in thrown).toBe(false);
    expect(JSON.stringify(thrown)).not.toContain('/private');
    expect(state.clients[0]!.close).toHaveBeenCalledTimes(1);
  });
});
