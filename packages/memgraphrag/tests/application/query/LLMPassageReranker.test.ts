/**
 * Tests for LLMPassageReranker (DES-MG4-006).
 */
import { describe, it, expect, vi } from 'vitest';
import { LLMPassageReranker } from '../../../src/application/query/LLMPassageReranker.js';
import type { PPRResult, RankedNode } from '../../../src/domain/retrieval/ppr.js';
import type { ILLMProvider } from '../../../src/domain/provider/llmProvider.js';
import type { GlobalMemory } from '../../../src/domain/memory/globalMemory.js';

function mockPassages(n: number): RankedNode[] {
  return Array.from({ length: n }, (_, i) => ({
    nodeId: `passage-${i}`,
    score: 1.0 - i * 0.05,
    layer: 'passage' as const,
  }));
}

function basePPRResult(n: number): PPRResult {
  return {
    rankedPassages: mockPassages(n),
    rankedEntities: [{ nodeId: 'entity-0', score: 0.5, layer: 'entity' as const }],
    iterations: 15,
    converged: true,
    l1Delta: 0.0001,
  };
}

function mockLLM(responseText: string): ILLMProvider {
  return {
    generate: vi.fn().mockResolvedValue({
      text: responseText,
      usage: { inputTokens: 100, outputTokens: 50 },
    }),
  } as unknown as ILLMProvider;
}

function mockGlobalMemory(): GlobalMemory {
  return {
    getPassage: vi.fn().mockImplementation((id: string) =>
      Promise.resolve({ text: `Text for ${id}`, metadata: { title: id, sourceUrl: '' } }),
    ),
  } as unknown as GlobalMemory;
}

describe('LLMPassageReranker', () => {
  it('reranks passages by LLM scores', async () => {
    const scores = [3, 8, 5, 7, 1]; // passage-1 highest
    const llm = mockLLM(JSON.stringify({ scores }));
    const reranker = new LLMPassageReranker(llm, mockGlobalMemory());

    const result = await reranker.rerank({
      query: 'Who founded Tesla?',
      ranking: basePPRResult(5),
      topN: 5,
      selectN: 3,
    });

    // passage-1 (score 8), passage-3 (score 7), passage-2 (score 5) = top 3
    expect(result.rerankedPPRResult.rankedPassages[0]!.nodeId).toBe('passage-1');
    expect(result.rerankedPPRResult.rankedPassages[1]!.nodeId).toBe('passage-3');
    expect(result.rerankedPPRResult.rankedPassages[2]!.nodeId).toBe('passage-2');
    // All 5 passages preserved
    expect(result.rerankedPPRResult.rankedPassages).toHaveLength(5);
    expect(result.metrics.positionChanges).toBeGreaterThan(0);
  });

  it('preserves PPRResult metadata (entities, iterations, converged)', async () => {
    const scores = [5, 5, 5];
    const llm = mockLLM(JSON.stringify({ scores }));
    const reranker = new LLMPassageReranker(llm, mockGlobalMemory());

    const result = await reranker.rerank({
      query: 'test',
      ranking: basePPRResult(3),
      topN: 3,
      selectN: 2,
    });

    expect(result.rerankedPPRResult.rankedEntities).toHaveLength(1);
    expect(result.rerankedPPRResult.iterations).toBe(15);
    expect(result.rerankedPPRResult.converged).toBe(true);
    expect(result.rerankedPPRResult.l1Delta).toBe(0.0001);
  });

  it('returns fallback on LLM error', async () => {
    const llm = {
      generate: vi.fn().mockRejectedValue(new Error('API timeout')),
    } as unknown as ILLMProvider;
    const reranker = new LLMPassageReranker(llm, mockGlobalMemory());
    const ranking = basePPRResult(5);

    const result = await reranker.rerank({
      query: 'test',
      ranking,
      topN: 5,
      selectN: 3,
    });

    // Fallback = original ranking unchanged
    expect(result.rerankedPPRResult).toBe(ranking);
    expect(result.metrics.positionChanges).toBe(0);
    expect(result.metrics.tokensUsed).toBe(0);
  });

  it('returns fallback on invalid JSON response', async () => {
    const llm = mockLLM('not valid json at all');
    const reranker = new LLMPassageReranker(llm, mockGlobalMemory());
    const ranking = basePPRResult(5);

    const result = await reranker.rerank({
      query: 'test',
      ranking,
      topN: 5,
      selectN: 3,
    });

    expect(result.rerankedPPRResult).toBe(ranking);
    expect(result.metrics.positionChanges).toBe(0);
  });

  it('returns fallback on score length mismatch', async () => {
    const llm = mockLLM(JSON.stringify({ scores: [5, 5] })); // expect 5, got 2
    const reranker = new LLMPassageReranker(llm, mockGlobalMemory());
    const ranking = basePPRResult(5);

    const result = await reranker.rerank({
      query: 'test',
      ranking,
      topN: 5,
      selectN: 3,
    });

    expect(result.rerankedPPRResult).toBe(ranking);
  });

  it('handles topN > passages gracefully', async () => {
    const scores = [7, 3];
    const llm = mockLLM(JSON.stringify({ scores }));
    const reranker = new LLMPassageReranker(llm, mockGlobalMemory());

    const result = await reranker.rerank({
      query: 'test',
      ranking: basePPRResult(2),
      topN: 10, // more than available
      selectN: 2,
    });

    expect(result.rerankedPPRResult.rankedPassages).toHaveLength(2);
    expect(result.rerankedPPRResult.rankedPassages[0]!.nodeId).toBe('passage-0'); // score 7
  });

  it('handles markdown-wrapped JSON response', async () => {
    const response = '```json\n{"scores": [9, 2, 5]}\n```';
    const llm = mockLLM(response);
    const reranker = new LLMPassageReranker(llm, mockGlobalMemory());

    const result = await reranker.rerank({
      query: 'test',
      ranking: basePPRResult(3),
      topN: 3,
      selectN: 2,
    });

    expect(result.rerankedPPRResult.rankedPassages[0]!.nodeId).toBe('passage-0'); // score 9
    expect(result.rerankedPPRResult.rankedPassages[1]!.nodeId).toBe('passage-2'); // score 5
  });

  it('computes correct metrics', async () => {
    const scores = [1, 10, 5, 3, 7];
    const llm = mockLLM(JSON.stringify({ scores }));
    const reranker = new LLMPassageReranker(llm, mockGlobalMemory());

    const result = await reranker.rerank({
      query: 'test',
      ranking: basePPRResult(5),
      topN: 5,
      selectN: 3,
    });

    expect(result.metrics.scoreRange.min).toBe(1);
    expect(result.metrics.scoreRange.max).toBe(10);
    expect(result.metrics.tokensUsed).toBe(150); // 100 + 50
    expect(result.metrics.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
