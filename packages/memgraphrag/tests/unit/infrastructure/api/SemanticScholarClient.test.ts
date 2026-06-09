import { rmSync } from 'node:fs';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { SemanticScholarCache } from '../../../../src/infrastructure/api/SemanticScholarCache.js';
import { SemanticScholarClient } from '../../../../src/infrastructure/api/SemanticScholarClient.js';

const cacheDir = 'testing/semantic-scholar-cache';

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

function createResponse(status: number, body: Record<string, unknown>, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  });
}

describe('TASK-MG-045: SemanticScholarClient', () => {
  it('retries transient failures with exponential backoff', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(createResponse(429, { error: 'rate limited' }, { 'retry-after': '0' }))
      .mockResolvedValueOnce(createResponse(503, { error: 'unavailable' }))
      .mockResolvedValueOnce(createResponse(200, { total: 1, data: [{ paperId: 'p1', title: 'Graph Networks', abstract: 'Graph methods for retrieval' }] }));
    const sleep = vi.fn().mockResolvedValue(undefined);

    const client = new SemanticScholarClient({ fetchImpl, sleep, maxRetries: 3 });
    const papers = await client.searchPapers('graph retrieval', ['title', 'abstract'], 5);

    expect(papers).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('uses the file cache to avoid duplicate fetches', async () => {
    const cache = new SemanticScholarCache(cacheDir);
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValue(createResponse(200, { total: 1, data: [{ paperId: 'p1', title: 'Cached Paper', abstract: 'Abstract' }] }));

    const firstClient = new SemanticScholarClient({ fetchImpl, cache });
    const secondClient = new SemanticScholarClient({ fetchImpl, cache });

    const first = await firstClient.searchPapers('cached query', ['title', 'abstract'], 3);
    const second = await secondClient.searchPapers('cached query', ['title', 'abstract'], 3);

    expect(first).toEqual(second);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throttles when the in-memory rate limit window is full', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => createResponse(200, { total: 0, data: [] }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = new SemanticScholarClient({
      fetchImpl,
      sleep,
      rateLimitMaxRequests: 1,
      rateLimitWindowMs: 60_000,
    });

    await client.searchPapers('first');
    await client.searchPapers('second');

    expect(sleep).toHaveBeenCalledTimes(1);
  });
});
