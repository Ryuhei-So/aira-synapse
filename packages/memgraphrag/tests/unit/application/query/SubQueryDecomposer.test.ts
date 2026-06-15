/**
 * Tests for SubQueryDecomposer (T-013).
 */
import { describe, it, expect, vi } from 'vitest';
import { SubQueryDecomposer } from '../../../../src/application/query/SubQueryDecomposer.js';
import type { ILLMProvider, TextGenerationResponse } from '../../../../src/domain/provider/index.js';
import type { INodeInitializer, NodeInitializationVector } from '../../../../src/domain/retrieval/memoryFilter.js';
import type { IGraphProjection, IPPR, PPRResult } from '../../../../src/domain/retrieval/ppr.js';

function mockLLM(response: string): ILLMProvider {
  return {
    generate: vi.fn().mockResolvedValue({
      text: response,
      model: 'test',
      usage: { inputTokens: 50, outputTokens: 30 },
    } satisfies TextGenerationResponse),
    healthCheck: vi.fn().mockResolvedValue({ healthy: true }),
  };
}

function mockInitializer(): INodeInitializer {
  return {
    initialize: vi.fn().mockResolvedValue({
      scores: { 'fact:bridge-1': 0.8, 'passage:p1': 0.5 },
      fallbackTriggered: false,
    }),
  };
}

function mockPPR(): IPPR {
  return {
    run: vi.fn().mockResolvedValue({
      rankedPassages: [{ nodeId: 'passage:p1', score: 0.9, layer: 'passage' }],
      rankedEntities: [{ nodeId: 'fact:bridge-1', score: 0.8, layer: 'fact' }],
      iterations: 10,
      converged: true,
      l1Delta: 1e-7,
    } satisfies PPRResult),
  };
}

function mockProjection(): IGraphProjection {
  return {
    getTransitions: vi.fn(),
    getDanglingNodes: vi.fn().mockResolvedValue([]),
    getNodeCount: vi.fn().mockResolvedValue(100),
  };
}

const makeRequest = (text: string) => ({
  query: { corpusId: 'test', text, topK: 10, topM: 5, threshold: 0.5, contextTokenLimit: 4000 },
  candidates: { ontology: [], facts: [], passages: [], expandedTerms: [], fallbackRequired: false },
});

describe('SubQueryDecomposer', () => {
  it('falls back for comparison queries', async () => {
    const decomposer = new SubQueryDecomposer(mockLLM('{}'), mockInitializer(), mockPPR(), mockProjection());
    const base: NodeInitializationVector = { scores: { 'fact:f1': 1.0 }, fallbackTriggered: false };

    const result = await decomposer.decompose(makeRequest('Which city is bigger, Tokyo or Osaka?'), base);

    expect(result.decomposed).toBe(false);
    expect(result.fallbackReason).toBe('comparison_query');
  });

  it('falls back when no bridge pattern detected', async () => {
    const decomposer = new SubQueryDecomposer(mockLLM('{}'), mockInitializer(), mockPPR(), mockProjection());
    const base: NodeInitializationVector = { scores: { 'fact:f1': 1.0 }, fallbackTriggered: false };

    const result = await decomposer.decompose(makeRequest('What is the capital of France?'), base);

    expect(result.decomposed).toBe(false);
    expect(result.fallbackReason).toBe('no_bridge_pattern');
  });

  it('decomposes bridge question successfully', async () => {
    const llmResponse = JSON.stringify({
      hop1Query: 'Who directed Inception?',
      expectedBridgeType: 'person',
    });
    const decomposer = new SubQueryDecomposer(mockLLM(llmResponse), mockInitializer(), mockPPR(), mockProjection());
    const base: NodeInitializationVector = { scores: { 'fact:f1': 1.0 }, fallbackTriggered: false };

    const result = await decomposer.decompose(
      makeRequest('Where was the person who directed Inception born?'),
      base,
    );

    expect(result.decomposed).toBe(true);
    expect(result.hop1FactCount).toBeGreaterThan(0);
    expect(result.hop2FactCount).toBeGreaterThan(0);
    // Merged vector should be L1 normalized
    const sum = Object.values(result.mergedVector.scores).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 5);
  });

  it('falls back on LLM error', async () => {
    const llm: ILLMProvider = {
      generate: vi.fn().mockRejectedValue(new Error('LLM down')),
      healthCheck: vi.fn().mockResolvedValue({ healthy: false }),
    };
    const decomposer = new SubQueryDecomposer(llm, mockInitializer(), mockPPR(), mockProjection());
    const base: NodeInitializationVector = { scores: { 'fact:f1': 1.0 }, fallbackTriggered: false };

    const result = await decomposer.decompose(
      makeRequest('Where was the person who directed Inception born?'),
      base,
    );

    expect(result.decomposed).toBe(false);
    expect(result.fallbackReason).toBe('llm_error');
  });

  it('falls back on deadline exceeded', async () => {
    const slowLLM: ILLMProvider = {
      generate: vi.fn().mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 20000))),
      healthCheck: vi.fn().mockResolvedValue({ healthy: true }),
    };
    const decomposer = new SubQueryDecomposer(slowLLM, mockInitializer(), mockPPR(), mockProjection(), 100);
    const base: NodeInitializationVector = { scores: { 'fact:f1': 1.0 }, fallbackTriggered: false };

    const result = await decomposer.decompose(
      makeRequest('Where was the person who directed Inception born?'),
      base,
    );

    expect(result.decomposed).toBe(false);
    expect(result.fallbackReason).toBe('deadline_exceeded');
  });
});
