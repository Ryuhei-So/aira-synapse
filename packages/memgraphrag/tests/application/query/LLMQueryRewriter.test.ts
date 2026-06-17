import { describe, it, expect, vi } from 'vitest';
import { LLMQueryRewriter } from '../../../src/application/query/LLMQueryRewriter.js';
import type { QueryRewriterDependencies } from '../../../src/application/query/LLMQueryRewriter.js';
import type { TextGenerationResponse } from '../../../src/domain/provider/llmProvider.js';
import type { PPRResult } from '../../../src/domain/retrieval/ppr.js';
import type { FilteredMemoryCandidates } from '../../../src/domain/retrieval/memoryFilter.js';

const MOCK_PPR_RESULT: PPRResult = {
  rankedPassages: [
    { nodeId: 'p1', score: 0.9, layer: 'passages' },
    { nodeId: 'p2', score: 0.7, layer: 'passages' },
    { nodeId: 'p3', score: 0.5, layer: 'passages' },
  ],
  rankedEntities: [{ nodeId: 'e1', score: 0.8, layer: 'facts' }],
  iterations: 4,
  converged: true,
  l1Delta: 0.0001,
};

const MOCK_CANDIDATES: FilteredMemoryCandidates = {
  ontology: [],
  facts: [],
  passages: [],
  expandedTerms: [],
  fallbackRequired: false,
};

function createMockDeps(overrides?: Partial<QueryRewriterDependencies>): QueryRewriterDependencies {
  return {
    llm: {
      generate: vi.fn().mockResolvedValue({
        text: '{"sub_queries": [{"step": 1, "query": "What city was founded by X?", "purpose": "find city"}, {"step": 2, "query": "What is the population of {step1}?", "depends_on": 1, "purpose": "find population"}]}',
        model: 'gpt-5.4-mini',
        usage: { inputTokens: 100, outputTokens: 50 },
      } satisfies TextGenerationResponse),
      healthCheck: vi.fn().mockResolvedValue({ healthy: true }),
    },
    memoryFilter: {
      filter: vi.fn().mockResolvedValue(MOCK_CANDIDATES),
    },
    nodeInitializer: {
      initialize: vi.fn().mockResolvedValue({ scores: { p1: 0.5 }, fallbackTriggered: false }),
    },
    ppr: {
      run: vi.fn().mockResolvedValue(MOCK_PPR_RESULT),
    },
    projection: {
      getTransitions: vi.fn(),
      getDanglingNodes: vi.fn().mockResolvedValue([]),
      getNodeCount: vi.fn().mockResolvedValue(100),
    },
    globalMemory: {
      getPassage: vi.fn().mockResolvedValue({ passageId: 'p1', text: 'Some passage text about the topic.', metadata: { title: 'Test', sourceUrl: '' } }),
      getSchema: vi.fn().mockResolvedValue(null),
      getFact: vi.fn().mockResolvedValue(null),
      listFactsBySchema: vi.fn().mockResolvedValue([]),
      listPassagesByFact: vi.fn().mockResolvedValue([]),
      listFactsByPassage: vi.fn().mockResolvedValue([]),
    } as any,
    timeoutMs: 5000,
    ...overrides,
  };
}

describe('LLMQueryRewriter', () => {
  const baseRequest = {
    query: { corpusId: 'test', text: 'What is the population of the city founded by John Smith?', topK: 10, topM: 10, threshold: 0.3, contextTokenLimit: 3000 },
  };

  it('decomposes a bridge query into 2 sub-queries and merges results', async () => {
    const deps = createMockDeps();
    (deps.llm.generate as any)
      .mockResolvedValueOnce({
        text: '{"sub_queries": [{"step": 1, "query": "What city was founded by John Smith?", "purpose": "find city"}, {"step": 2, "query": "What is the population of {step1}?", "depends_on": 1, "purpose": "find population"}]}',
        model: 'gpt-5.4-mini',
        usage: { inputTokens: 100, outputTokens: 50 },
      })
      .mockResolvedValueOnce({
        text: 'Springfield',
        model: 'gpt-5.4-mini',
        usage: { inputTokens: 50, outputTokens: 5 },
      });

    const rewriter = new LLMQueryRewriter(deps);
    const result = await rewriter.rewrite(baseRequest);

    expect(result.decomposed).toBe(true);
    expect(result.fallback).toBe(false);
    expect(result.subQueries).toHaveLength(2);
    expect(result.intermediateAnswers).toEqual(['Springfield']);
    expect(result.mergedRanking.rankedPassages.length).toBeGreaterThan(0);
    expect(deps.ppr.run).toHaveBeenCalledTimes(2);
  });

  it('falls back on invalid JSON from LLM', async () => {
    const deps = createMockDeps();
    (deps.llm.generate as any).mockResolvedValueOnce({
      text: 'not valid json at all',
      model: 'gpt-5.4-mini',
      usage: { inputTokens: 50, outputTokens: 10 },
    });

    const rewriter = new LLMQueryRewriter(deps);
    const result = await rewriter.rewrite(baseRequest);

    expect(result.decomposed).toBe(false);
    expect(result.fallback).toBe(true);
    expect(result.fallbackReason).toBe('decomposition_failed');
    expect(deps.ppr.run).toHaveBeenCalled();
  });

  it('falls back when only 1 sub-query returned', async () => {
    const deps = createMockDeps();
    (deps.llm.generate as any).mockResolvedValueOnce({
      text: '{"sub_queries": [{"step": 1, "query": "Only one query", "purpose": "test"}]}',
      model: 'gpt-5.4-mini',
      usage: { inputTokens: 50, outputTokens: 20 },
    });

    const rewriter = new LLMQueryRewriter(deps);
    const result = await rewriter.rewrite(baseRequest);

    expect(result.decomposed).toBe(false);
    expect(result.fallback).toBe(true);
    expect(result.fallbackReason).toBe('decomposition_failed');
  });

  it('falls back when {step1} placeholder is missing', async () => {
    const deps = createMockDeps();
    (deps.llm.generate as any).mockResolvedValueOnce({
      text: '{"sub_queries": [{"step": 1, "query": "Find X", "purpose": "a"}, {"step": 2, "query": "Find Y without placeholder", "depends_on": 1, "purpose": "b"}]}',
      model: 'gpt-5.4-mini',
      usage: { inputTokens: 50, outputTokens: 30 },
    });

    const rewriter = new LLMQueryRewriter(deps);
    const result = await rewriter.rewrite(baseRequest);

    expect(result.decomposed).toBe(false);
    expect(result.fallback).toBe(true);
  });

  it('falls back on LLM timeout', async () => {
    const deps = createMockDeps({ timeoutMs: 10 });
    (deps.llm.generate as any).mockImplementation(() => new Promise(resolve => setTimeout(resolve, 1000)));

    const rewriter = new LLMQueryRewriter(deps);
    const result = await rewriter.rewrite(baseRequest);

    expect(result.decomposed).toBe(false);
    expect(result.fallback).toBe(true);
    expect(result.fallbackReason).toBe('decomposition_failed');
  });

  it('falls back when intermediate extraction returns empty', async () => {
    const deps = createMockDeps();
    (deps.llm.generate as any)
      .mockResolvedValueOnce({
        text: '{"sub_queries": [{"step": 1, "query": "Find X", "purpose": "a"}, {"step": 2, "query": "Find {step1} details", "depends_on": 1, "purpose": "b"}]}',
        model: 'gpt-5.4-mini',
        usage: { inputTokens: 100, outputTokens: 50 },
      })
      .mockResolvedValueOnce({
        text: '',
        model: 'gpt-5.4-mini',
        usage: { inputTokens: 50, outputTokens: 0 },
      });

    const rewriter = new LLMQueryRewriter(deps);
    const result = await rewriter.rewrite(baseRequest);

    expect(result.decomposed).toBe(false);
    expect(result.fallback).toBe(true);
    expect(result.fallbackReason).toBe('intermediate_extraction_failed');
  });

  it('mergeRankings caps output at topK', async () => {
    const deps = createMockDeps();
    const manyPassages = Array.from({ length: 20 }, (_, i) => ({
      nodeId: `p${i}`, score: 1 - i * 0.05, layer: 'passages' as const,
    }));
    (deps.ppr.run as any).mockResolvedValue({
      ...MOCK_PPR_RESULT,
      rankedPassages: manyPassages,
    });
    (deps.llm.generate as any)
      .mockResolvedValueOnce({
        text: '{"sub_queries": [{"step": 1, "query": "Find X", "purpose": "a"}, {"step": 2, "query": "Find {step1} Y", "depends_on": 1, "purpose": "b"}]}',
        model: 'gpt-5.4-mini',
        usage: { inputTokens: 100, outputTokens: 50 },
      })
      .mockResolvedValueOnce({
        text: 'IntermediateResult',
        model: 'gpt-5.4-mini',
        usage: { inputTokens: 50, outputTokens: 5 },
      });

    const rewriter = new LLMQueryRewriter(deps);
    const result = await rewriter.rewrite(baseRequest);

    expect(result.decomposed).toBe(true);
    expect(result.mergedRanking.rankedPassages.length).toBeLessThanOrEqual(10);
  });
});
