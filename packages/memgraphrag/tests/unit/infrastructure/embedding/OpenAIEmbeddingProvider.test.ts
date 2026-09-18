import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIEmbeddingProvider } from '../../../../src/infrastructure/embedding/OpenAIEmbeddingProvider.js';

const API_KEY = 'sk-embedding-secret';

describe('TASK-MG-024: OpenAIEmbeddingProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns LOCAL_EMBEDDING_REQUIRED when no API key is configured', async () => {
    const provider = new OpenAIEmbeddingProvider({ apiKey: '', model: 'embed-test' });

    await expect(provider.embed({ texts: ['hello'] })).rejects.toThrow(
      'LOCAL_EMBEDDING_REQUIRED',
    );
    await expect(provider.healthCheck()).resolves.toEqual({
      healthy: false,
      message:
        'LOCAL_EMBEDDING_REQUIRED: local_only mode requires a local embedding provider',
    });
  });

  it('caches embeddings and avoids duplicate fetches on cache hit', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAIEmbeddingProvider({ apiKey: API_KEY, model: 'embed-test' });

    const first = await provider.embed({ texts: ['cached text'] });
    const second = await provider.embed({ texts: ['cached text'] });

    expect(first).toEqual({
      model: 'embed-test',
      vectors: [[0.1, 0.2, 0.3]],
      cached: false,
    });
    expect(second).toEqual({
      model: 'embed-test',
      vectors: [[0.1, 0.2, 0.3]],
      cached: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('handles batch requests with partial cache misses', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: [{ index: 0, embedding: [0, 1] }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAIEmbeddingProvider({ apiKey: API_KEY, model: 'embed-test' });

    await provider.embed({ texts: ['alpha'] });
    const result = await provider.embed({ texts: ['alpha', 'beta'] });

    expect(result).toEqual({
      model: 'embed-test',
      vectors: [
        [1, 0],
        [0, 1],
      ],
      cached: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse((fetchMock.mock.calls[1]?.[1]?.body as string) ?? '{}') as {
      input?: string[];
    };
    expect(secondBody.input).toEqual(['beta']);
  });

  it('splits uncached texts into bounded requests and maps every vector back to its input', async () => {
    const seen: string[][] = [];
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse((init?.body as string) ?? '{}') as { input: string[] };
      seen.push(body.input);
      return new Response(
        JSON.stringify({ data: body.input.map((text, index) => ({ index, embedding: [Number(text.replace('t', ''))] })) }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAIEmbeddingProvider({ apiKey: API_KEY, model: 'embed-test', batchSize: 3 });
    await provider.embed({ texts: ['t1'] });
    const texts = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'];
    const result = await provider.embed({ texts });

    expect(result.vectors).toEqual(texts.map((text) => [Number(text.replace('t', ''))]));
    // t1 was cached; the remaining seven travel in ceil(7 / 3) requests of at most three.
    expect(seen.slice(1)).toEqual([['t2', 't3', 't4'], ['t5', 't6', 't7'], ['t8']]);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    // Everything is now cached: no request at all.
    const again = await provider.embed({ texts });
    expect(again.cached).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('fails a batch whose vector count does not match its inputs instead of misaligning later batches', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse((init?.body as string) ?? '{}') as { input: string[] };
      const rows = body.input.slice(0, body.input.length - 1).map((_text, index) => ({ index, embedding: [index] }));
      return new Response(JSON.stringify({ data: rows }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAIEmbeddingProvider({ apiKey: API_KEY, model: 'embed-test', batchSize: 2 });
    await expect(provider.embed({ texts: ['a', 'b', 'c'] })).rejects.toThrow(/returned 1 vectors for 2 inputs/);
  });

  it('rejects a non-positive or fractional batch size at construction', () => {
    expect(() => new OpenAIEmbeddingProvider({ apiKey: API_KEY, model: 'embed-test', batchSize: 0 })).toThrow(/batchSize/);
    expect(() => new OpenAIEmbeddingProvider({ apiKey: API_KEY, model: 'embed-test', batchSize: 1.5 })).toThrow(/batchSize/);
  });
});
