/**
 * Unit tests for T5b: Decomposition + fallback conditions 1-4.
 */
import { describe, it, expect, vi } from 'vitest';
import { decomposeQuestion } from '../../../src/application/query/multiHopDecompose.js';
import type { ILLMProvider, TextGenerationResponse } from '../../../src/domain/provider/llmProvider.js';

function mockLLM(text: string): ILLMProvider {
  return {
    generate: vi.fn().mockResolvedValue({
      text,
      model: 'test',
      usage: { inputTokens: 50, outputTokens: 20 },
    } satisfies TextGenerationResponse),
    healthCheck: vi.fn(),
  };
}

describe('decomposeQuestion', () => {
  it('should return valid decomposition', async () => {
    const llm = mockLLM(JSON.stringify({
      hop1SubQuestion: 'What is the capital of France?',
      hop2SubQuestion: 'When was {hop1Answer} founded?',
      bridgeEntityHint: 'city',
    }));

    const result = await decomposeQuestion('When was the capital of France founded?', llm);

    expect(result.decomposition).toBeDefined();
    expect(result.decomposition!.hop1SubQuestion).toBe('What is the capital of France?');
    expect(result.decomposition!.hop2SubQuestion).toContain('{hop1Answer}');
    expect(result.decomposition!.bridgeEntityHint).toBe('city');
    expect(result.fallbackReason).toBeUndefined();
  });

  it('fallback 1: should return decomposition_parse_error on invalid JSON', async () => {
    const llm = mockLLM('not valid json {{{');
    const result = await decomposeQuestion('test question', llm);
    expect(result.fallbackReason).toBe('decomposition_parse_error');
    expect(result.decomposition).toBeUndefined();
  });

  it('fallback 2: should return decomposition_missing_field when hop1 missing', async () => {
    const llm = mockLLM(JSON.stringify({
      hop2SubQuestion: 'something about {hop1Answer}',
    }));
    const result = await decomposeQuestion('test', llm);
    expect(result.fallbackReason).toBe('decomposition_missing_field');
  });

  it('fallback 2: should return decomposition_missing_field when hop2 is empty', async () => {
    const llm = mockLLM(JSON.stringify({
      hop1SubQuestion: 'Q1',
      hop2SubQuestion: '   ',
    }));
    const result = await decomposeQuestion('test', llm);
    expect(result.fallbackReason).toBe('decomposition_missing_field');
  });

  it('fallback 3: should return decomposition_missing_placeholder when no {hop1Answer}', async () => {
    const llm = mockLLM(JSON.stringify({
      hop1SubQuestion: 'What is X?',
      hop2SubQuestion: 'When was Y founded?',
    }));
    const result = await decomposeQuestion('test', llm);
    expect(result.fallbackReason).toBe('decomposition_missing_placeholder');
  });

  it('fallback 4: should return decomposition_duplicate_hops', async () => {
    const llm = mockLLM(JSON.stringify({
      hop1SubQuestion: 'What is the answer?',
      hop2SubQuestion: 'What is the answer? {hop1Answer}',
    }));
    const result = await decomposeQuestion('test', llm);
    // hop1 == hop2 minus placeholder (after trim/lowercase)
    // "what is the answer?" === "what is the answer?" → duplicate
    expect(result.fallbackReason).toBe('decomposition_duplicate_hops');
  });

  it('should track usage in all cases', async () => {
    const llm = mockLLM('invalid');
    const result = await decomposeQuestion('test', llm);
    expect(result.usage.inputTokens).toBe(50);
    expect(result.usage.outputTokens).toBe(20);
  });

  it('should pass signal to LLM', async () => {
    const controller = new AbortController();
    const generateFn = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        hop1SubQuestion: 'Q1',
        hop2SubQuestion: '{hop1Answer} Q2',
      }),
      model: 'test',
      usage: { inputTokens: 10, outputTokens: 10 },
    });
    const llm: ILLMProvider = { generate: generateFn, healthCheck: vi.fn() };

    await decomposeQuestion('test', llm, controller.signal);

    expect(generateFn).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('should handle optional bridgeEntityHint', async () => {
    const llm = mockLLM(JSON.stringify({
      hop1SubQuestion: 'Who directed Inception?',
      hop2SubQuestion: 'What other films did {hop1Answer} direct?',
    }));
    const result = await decomposeQuestion('test', llm);
    expect(result.decomposition!.bridgeEntityHint).toBeUndefined();
  });
});
