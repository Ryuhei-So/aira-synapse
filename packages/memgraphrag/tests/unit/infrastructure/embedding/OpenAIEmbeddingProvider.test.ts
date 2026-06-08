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
});
