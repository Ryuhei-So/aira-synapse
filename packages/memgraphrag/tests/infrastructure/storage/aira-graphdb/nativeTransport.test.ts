import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { AiraGraphDbNativeClient } from '../../../../src/infrastructure/storage/aira-graphdb/NativeClient.js';
import { createAiraGraphDbAdapters } from '../../../../src/infrastructure/storage/ladybug/storageFactory.js';
import { CachedGraphProjection } from '../../../../src/infrastructure/storage/cached/CachedGraphProjection.js';

const fakeNative = fileURLToPath(new URL('../../../support/fake-native-large-line.mjs', import.meta.url));
const LARGE_REPLY_BYTES = 300 * 1024 * 1024;
const LARGE_REPLY_BUDGET_MS = 60_000;

const previous = {
  cmd: process.env.AIRA_GRAPHDB_NATIVE_CMD,
  transitions: process.env.FAKE_TRANSITIONS,
};

function useFakeNative(transitions?: number): void {
  process.env.AIRA_GRAPHDB_NATIVE_CMD = `${process.execPath} ${fakeNative}`;
  if (transitions === undefined) delete process.env.FAKE_TRANSITIONS;
  else process.env.FAKE_TRANSITIONS = String(transitions);
}

afterEach(() => {
  if (previous.cmd === undefined) delete process.env.AIRA_GRAPHDB_NATIVE_CMD;
  else process.env.AIRA_GRAPHDB_NATIVE_CMD = previous.cmd;
  if (previous.transitions === undefined) delete process.env.FAKE_TRANSITIONS;
  else process.env.FAKE_TRANSITIONS = previous.transitions;
});

describe('AiraGraphDbNativeClient transport', () => {
  it('delivers a 300 MB single-line reply within a bounded budget', async () => {
    useFakeNative();
    const client = new AiraGraphDbNativeClient('/tmp/native-transport-test');
    try {
      const started = performance.now();
      const timer = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`budget exceeded: ${LARGE_REPLY_BUDGET_MS} ms`)), LARGE_REPLY_BUDGET_MS).unref();
      });
      const reply = await Promise.race([client.request<string>('huge', { bytes: LARGE_REPLY_BYTES }), timer]);
      expect(reply.length).toBe(LARGE_REPLY_BYTES);
      expect(performance.now() - started).toBeLessThan(LARGE_REPLY_BUDGET_MS);
    } finally {
      await client.close();
    }
  }, LARGE_REPLY_BUDGET_MS + 10_000);

  it('fails closed when a reply exceeds the per-request response bound', async () => {
    useFakeNative();
    // production-runtime bounds every reply frame by the request's own
    // maxResponseBytes (the 471 line splitter's role); an oversized frame
    // poisons the client instead of growing the heap.
    const client = new AiraGraphDbNativeClient('/tmp/native-transport-test');
    try {
      await expect(client.request('huge', { bytes: 4096 }, { maxRequestBytes: 1024 * 1024, maxResponseBytes: 1024 }))
        .rejects.toThrow(/response exceeds 1024 bytes/);
      await expect(client.request('huge', { bytes: 1 })).rejects.toThrow(/response exceeds 1024 bytes/);
    } finally {
      await client.close();
    }
  });

  it('still delivers a reply that fits the bound exactly', async () => {
    useFakeNative();
    // `{"id":1,"ok":true,"result":"<bytes a>"}` must fit: limit = payload size.
    const bytes = 1000;
    const envelope = JSON.stringify({ id: 1, ok: true, result: 'a'.repeat(bytes) }).length;
    const client = new AiraGraphDbNativeClient('/tmp/native-transport-test');
    try {
      const reply = await client.request<string>('huge', { bytes }, { maxRequestBytes: 1024 * 1024, maxResponseBytes: envelope });
      expect(reply.length).toBe(bytes);
    } finally {
      await client.close();
    }
  });
});

describe('aira-graphdb graph projection caching', () => {
  it('pulls the transition list once per process and again only after the store version changes', async () => {
    useFakeNative(5);
    const adapters = await createAiraGraphDbAdapters({ dbPath: '/tmp/native-transport-test' });
    try {
      const projection = adapters.graphProjection;
      expect(projection).toBeInstanceOf(CachedGraphProjection);
      const cached = projection as CachedGraphProjection;
      const drain = async () => {
        const entries = [];
        for await (const entry of projection.getTransitions('corpus')) entries.push(entry);
        return entries;
      };
      expect(cached.invalidateIfVersionChanged(302)).toBe(false);
      expect(await drain()).toHaveLength(5);
      expect(await drain()).toHaveLength(5);
      expect(await drain()).toHaveLength(5);
      // Same version observed again: no reload.
      expect(cached.invalidateIfVersionChanged(302)).toBe(false);
      expect(await drain()).toHaveLength(5);
      const calls = await requestCalls(adapters);
      expect(calls.projection_get_transitions).toBe(1);
      expect(cached.invalidateIfVersionChanged(303)).toBe(true);
      expect(await drain()).toHaveLength(5);
      expect((await requestCalls(adapters)).projection_get_transitions).toBe(2);
    } finally {
      await adapters.close();
    }
  });
});

async function requestCalls(adapters: Awaited<ReturnType<typeof createAiraGraphDbAdapters>>): Promise<Record<string, number>> {
  // The adapters share one native child; the lexical retriever exposes the
  // same client's request path, so route a `calls` probe through it.
  const client = (adapters.lexicalRetriever as unknown as { client: AiraGraphDbNativeClient }).client;
  return client.request<Record<string, number>>('calls');
}
