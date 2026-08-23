import { describe, it, expect, vi } from 'vitest';
import { FederatedQueryService } from '../../src/application/query/FederatedQueryService.js';
import { DefaultRRFMerger } from '../../src/application/query/DefaultRRFMerger.js';
import type { FederatedQueryConfig, FederatedDbConfig } from '../../src/application/query/federationTypes.js';
import type { DefaultQueryService } from '../../src/application/query/QueryService.js';
import type { QueryRequest } from '../../src/domain/retrieval/memoryFilter.js';
import type { RetrievedQueryContext, PreparedQuery } from '../../src/domain/retrieval/federation.js';
import type { Passage } from '../../src/domain/memory/passage.js';

import type { IEmbeddingProvider, ILLMProvider } from '../../src/domain/provider/index.js';

function makePassage(id: string, text: string): Passage {
  return {
    passageId: id, text, normalizedText: text.toLowerCase(),
    metadata: { documentId: `doc-${id}`, title: `T-${id}`, sourceUrl: `http://${id}.com`, language: 'en', sectionPath: [], chunkId: id, chunkIndex: 0, offsetStart: 0, offsetEnd: text.length },
    corpusId: 'test', factIds: [], entityMentions: [], qualityFlags: [], createdAt: '', updatedAt: '',
  };
}

function makeRetrievedContext(passages: Passage[]): RetrievedQueryContext {
  return {
    passages: passages.map((p, i) => ({ passage: p, score: 1 - i * 0.1, rank: i + 1 })),
    facts: [],
    pprResult: { rankedPassages: [], rankedEntities: [], iterations: 5, converged: true, l1Delta: 0 },
    contextBundle: { promptContext: passages.map((p) => `Passage: ${p.text}`).join('\n'), citedPassages: passages, citedFacts: [], confidence: 0.9 },
    normalizedText: 'test', expandedRequest: { corpusId: 'test', text: 'test', topK: 10, topM: 5, threshold: 0.5, contextTokenLimit: 3000 },
    entityHits: [], dictionaryHints: '', isComparison: false, queryVector: [0.1, 0.2],
    metrics: { dictionaryMatchCount: 0, expandedTerms: [], fallbackTriggered: false, pprIterations: 5, pprConverged: true, citedPassageCount: passages.length, latencyMs: 50 },
  };
}

function createMockPrimaryService(): DefaultQueryService {
  const prepared: PreparedQuery = {
    normalizedText: 'test query', expandedRequest: { corpusId: 'test', text: 'test query', topK: 10, topM: 5, threshold: 0.5, contextTokenLimit: 3000 },
    entityHits: [], dictionaryHints: '', isComparison: false,
  };
  return {
    prepare: vi.fn().mockResolvedValue(prepared),
    retrievePrepared: vi.fn().mockResolvedValue(makeRetrievedContext([makePassage('primary', 'primary')])),
    answer: vi.fn().mockResolvedValue({ response: 'answer', citations: [], entities: [], metrics: { dictionaryMatchCount: 0, expandedTerms: [], fallbackTriggered: false, pprIterations: 0, pprConverged: true, citedPassageCount: 0, llmInputTokens: 10, llmOutputTokens: 5 } }),
    query: vi.fn(),
    retrieve: vi.fn(),
    dependencies: {} as unknown as DefaultQueryService['dependencies'],
  } as unknown as DefaultQueryService;
}

function createMockEmbedding(): IEmbeddingProvider {
  return {
    embed: vi.fn().mockResolvedValue({ model: 'test', vectors: [[0.1, 0.2, 0.3]], cached: false }),
    healthCheck: vi.fn().mockResolvedValue({ status: 'ok' }),
  } as unknown as IEmbeddingProvider;
}

function createMockDbFactory(contexts: Record<string, RetrievedQueryContext>) {
  return vi.fn(async (config: FederatedDbConfig) => ({
    adapters: { close: vi.fn().mockResolvedValue(undefined) } as unknown as { close(): Promise<void> },
    queryService: {
      retrievePrepared: vi.fn().mockResolvedValue(contexts[config.dbId] ?? makeRetrievedContext([])),
    } as unknown as DefaultQueryService,
  }));
}

const defaultConfig: FederatedQueryConfig = {
  databases: [
    { dbId: 'db1', dbPath: './db1.agdb' },
    { dbId: 'db2', dbPath: './db2.agdb' },
  ],
  rrfK: 60, perDbTopK: 10, globalTopK: 10, maxContributionRatio: 0.7,
  contextTokenBudget: 3000, perDbTimeoutMs: 30000, maxParallelism: 5,
};

describe('FederatedQueryService', () => {
  const request: QueryRequest = { corpusId: 'test', text: 'test query', topK: 10, topM: 5, threshold: 0.5, contextTokenLimit: 3000 };

  it('happy path: merges results from two DBs', async () => {
    const db1Ctx = makeRetrievedContext([makePassage('p1', 'physics text')]);
    const db2Ctx = makeRetrievedContext([makePassage('p2', 'chemistry text')]);

    const service = new FederatedQueryService(defaultConfig, {
      embeddingProvider: createMockEmbedding(),
      primaryService: createMockPrimaryService(),
      dbFactory: createMockDbFactory({ db1: db1Ctx, db2: db2Ctx }),
      merger: new DefaultRRFMerger(),
      llm: {} as ILLMProvider,
    });

    const result = await service.query(request);
    expect(result.response).toBe('answer');
    expect(result.metrics.federationEnabled).toBe(true);
    expect(result.metrics.federatedDbCount).toBe(2);
    expect(result.metrics.federatedSuccessCount).toBe(2);
    expect(result.warnings).toBeUndefined();

    await service.close();
  });

  it('partial failure: one DB fails, other succeeds', async () => {
    const db1Ctx = makeRetrievedContext([makePassage('p1', 'physics text')]);

    const dbFactory = vi.fn(async (config: FederatedDbConfig) => {
      if (config.dbId === 'db2') {
        return {
          adapters: { close: vi.fn().mockResolvedValue(undefined) } as unknown as { close(): Promise<void> },
          queryService: {
            retrievePrepared: vi.fn().mockRejectedValue(new Error('DB connection failed')),
          } as unknown as DefaultQueryService,
        };
      }
      return {
        adapters: { close: vi.fn().mockResolvedValue(undefined) } as unknown as { close(): Promise<void> },
        queryService: {
          retrievePrepared: vi.fn().mockResolvedValue(db1Ctx),
        } as unknown as DefaultQueryService,
      };
    });

    const service = new FederatedQueryService(defaultConfig, {
      embeddingProvider: createMockEmbedding(),
      primaryService: createMockPrimaryService(),
      dbFactory,
      merger: new DefaultRRFMerger(),
      llm: {} as ILLMProvider,
    });

    const result = await service.query(request);
    expect(result.response).toBe('answer');
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some((w) => w.includes('db2'))).toBe(true);

    await service.close();
  });

  it('total failure: all DBs fail → throws FederatedQueryError', async () => {
    const dbFactory = vi.fn(async () => ({
      adapters: { close: vi.fn().mockResolvedValue(undefined) } as unknown as { close(): Promise<void> },
      queryService: {
        retrievePrepared: vi.fn().mockRejectedValue(new Error('fail')),
      } as unknown as DefaultQueryService,
    }));

    const service = new FederatedQueryService(defaultConfig, {
      embeddingProvider: createMockEmbedding(),
      primaryService: createMockPrimaryService(),
      dbFactory,
      merger: new DefaultRRFMerger(),
      llm: {} as ILLMProvider,
    });

    await expect(service.query(request)).rejects.toThrow('All databases failed');
    await service.close();
  });

  it('embedding is called exactly once', async () => {
    const embedding = createMockEmbedding();
    const service = new FederatedQueryService(defaultConfig, {
      embeddingProvider: embedding,
      primaryService: createMockPrimaryService(),
      dbFactory: createMockDbFactory({ db1: makeRetrievedContext([]), db2: makeRetrievedContext([]) }),
      merger: new DefaultRRFMerger(),
      llm: {} as ILLMProvider,
    });

    await service.query(request);
    expect(embedding.embed).toHaveBeenCalledTimes(1);

    await service.close();
  });

  it('per-DB corpusId is applied', async () => {
    const config: FederatedQueryConfig = {
      ...defaultConfig,
      databases: [
        { dbId: 'db1', dbPath: './db1.agdb', corpusId: 'physics-corpus' },
        { dbId: 'db2', dbPath: './db2.agdb' },
      ],
    };

    const retrieveMock = vi.fn().mockResolvedValue(makeRetrievedContext([]));
    const dbFactory = vi.fn(async () => ({
      adapters: { close: vi.fn().mockResolvedValue(undefined) } as unknown as { close(): Promise<void> },
      queryService: { retrievePrepared: retrieveMock } as unknown as DefaultQueryService,
    }));

    const service = new FederatedQueryService(config, {
      embeddingProvider: createMockEmbedding(),
      primaryService: createMockPrimaryService(),
      dbFactory,
      merger: new DefaultRRFMerger(),
      llm: {} as ILLMProvider,
    });

    await service.query(request);

    const calls = retrieveMock.mock.calls;
    const db1Call = calls[0]?.[0] as PreparedQuery;
    const db2Call = calls[1]?.[0] as PreparedQuery;
    expect(db1Call.expandedRequest.corpusId).toBe('physics-corpus');
    expect(db2Call.expandedRequest.corpusId).toBe('test');

    await service.close();
  });

  it('citations include dbId after namespacing', async () => {
    const db1Ctx = makeRetrievedContext([makePassage('p1', 'text')]);
    const service = new FederatedQueryService(
      { ...defaultConfig, databases: [{ dbId: 'physics', dbPath: './p.agdb' }] },
      {
        embeddingProvider: createMockEmbedding(),
        primaryService: createMockPrimaryService(),
        dbFactory: createMockDbFactory({ physics: db1Ctx }),
        merger: new DefaultRRFMerger(),
        llm: {} as ILLMProvider,
      },
    );

    const ctx = await service.retrieve(request);
    expect(ctx.passages[0]!.passage.passageId).toContain('physics:');
    expect(ctx.passages[0]!.dbId).toBe('physics');

    await service.close();
  });
});
