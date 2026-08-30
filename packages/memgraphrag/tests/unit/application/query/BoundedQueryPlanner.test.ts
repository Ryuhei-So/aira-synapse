import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueryFeatureFlags } from '../../../../src/domain/config/featureFlags.js';
import { DEFAULT_QUERY_FLAGS } from '../../../../src/domain/config/featureFlags.js';
import type { IEmbeddingProvider } from '../../../../src/domain/provider/index.js';
import type { QueryRequest } from '../../../../src/domain/retrieval/memoryFilter.js';
import type { MemGraphRagConfig } from '../../../../src/infrastructure/config/index.js';
import {
  DefaultBoundedQueryPlanner,
} from '../../../../src/application/query/BoundedQueryPlanner.js';
import { DefaultQueryService } from '../../../../src/application/query/QueryService.js';
import { createBoundedQueryPlanner } from '../../../../src/interface/runtime/MemGraphRagRuntime.js';

const REQUEST: QueryRequest = {
  corpusId: 'corpus-1',
  text: '  compare\n alcohol treatment and placebo  ',
  topK: 10,
  topM: 5,
  threshold: 0.5,
  contextTokenLimit: 8_000,
};

function provider(vectors: readonly (readonly number[])[] = [[0.25, -0.5]]) {
  return {
    embed: vi.fn<IEmbeddingProvider['embed']>().mockResolvedValue({
      model: 'test-embedding',
      vectors,
      cached: false,
    }),
    healthCheck: vi.fn<IEmbeddingProvider['healthCheck']>(),
  } satisfies IEmbeddingProvider;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('DefaultBoundedQueryPlanner', () => {
  it('produces the exact existing QueryService V15 plan without storage dependencies', async () => {
    const embedding = provider();
    const planner = new DefaultBoundedQueryPlanner({ embeddingProvider: embedding });
    const queryService = new DefaultQueryService({
      dictionary: { match: vi.fn().mockResolvedValue([]) } as never,
      expansionPolicy: { expandQuery: vi.fn() },
      memoryFilter: {} as never,
      nodeInitializer: {} as never,
      ppr: {} as never,
      projection: {} as never,
      contextBuilder: {} as never,
      llm: {} as never,
    });

    const prepared = await queryService.prepare(REQUEST);
    const expected = queryService.createBoundedRetrievalRequestPlan(prepared, [0.25, -0.5]);

    expect(await planner.plan(REQUEST)).toEqual(expected);
    expect(embedding.embed).toHaveBeenCalledExactlyOnceWith({
      texts: ['compare alcohol treatment and placebo'],
    });
  });

  it('rejects every unsupported feature before embedding', async () => {
    for (const key of Object.keys(DEFAULT_QUERY_FLAGS) as (keyof QueryFeatureFlags)[]) {
      const embedding = provider();
      const flags = { ...DEFAULT_QUERY_FLAGS, [key]: true };
      const planner = new DefaultBoundedQueryPlanner({
        embeddingProvider: embedding,
        featureFlags: flags,
      });
      await expect(planner.plan(REQUEST)).rejects.toThrow(key);
      expect(embedding.embed).not.toHaveBeenCalled();
    }
  });

  it('rejects every malformed request field before embedding', async () => {
    const cases: readonly [string, Partial<QueryRequest>][] = [
      ['corpusId', { corpusId: '' }],
      ['text', { text: '' }],
      ['text whitespace', { text: ' \n ' }],
      ['topK', { topK: 0 }],
      ['topM', { topM: Number.NaN }],
      ['threshold', { threshold: 2 }],
      ['contextTokenLimit', { contextTokenLimit: 0 }],
    ];
    for (const [name, mutation] of cases) {
      const embedding = provider();
      const planner = new DefaultBoundedQueryPlanner({ embeddingProvider: embedding });
      await expect(planner.plan({ ...REQUEST, ...mutation }), name).rejects.toThrow();
      expect(embedding.embed, name).not.toHaveBeenCalled();
    }
  });

  it('rejects empty and non-finite provider output before returning a plan', async () => {
    for (const vectors of [[], [[]], [[Number.NaN]], [[Number.POSITIVE_INFINITY]]]) {
      const planner = new DefaultBoundedQueryPlanner({ embeddingProvider: provider(vectors) });
      await expect(planner.plan(REQUEST)).rejects.toThrow(/queryVector/);
    }
  });

  it('configured planner executes without opening or creating configured storage paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bounded-planner-'));
    const sqlitePath = join(root, 'must-not-exist', 'memory.sqlite');
    const vectorPath = join(root, 'must-not-exist', 'vectors');
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ index: 0, embedding: [0.25, -0.5] }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const config = {
      version: 1,
      localOnly: false,
      providers: {
        llm: { backend: 'openai', model: 'unused', temperature: 0, maxTokens: 1 },
        embedding: {
          backend: 'openai',
          model: 'test-embedding',
          dimensions: 17,
          cacheDir: join(root, 'cache'),
        },
        nlp: { backend: 'regex', requestTimeoutMs: 1, healthcheckTimeoutMs: 1 },
      },
      storage: {
        backend: 'aira-graphdb',
        sqlitePath,
        vectorIndexDir: vectorPath,
        walMode: true,
        autoMigrate: true,
      },
    } as MemGraphRagConfig;

    const planner = createBoundedQueryPlanner(config);
    await expect(planner.plan(REQUEST)).resolves.toMatchObject({ corpusId: 'corpus-1' });
    const providerBody = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect(providerBody).toMatchObject({ model: 'test-embedding' });
    expect(providerBody).not.toHaveProperty('dimensions');
    expect(existsSync(join(root, 'must-not-exist'))).toBe(false);
  });
});
