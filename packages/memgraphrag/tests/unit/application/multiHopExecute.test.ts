/**
 * Unit tests for T5c: Hop execution + grounding fallback 5-8.
 */
import { describe, it, expect, vi } from 'vitest';
import { executeHop } from '../../../src/application/query/multiHopExecute.js';
import type { ILLMProvider, TextGenerationResponse } from '../../../src/domain/provider/llmProvider.js';

function mockLLM(text: string): ILLMProvider {
  return {
    generate: vi.fn().mockResolvedValue({
      text,
      model: 'test',
      usage: { inputTokens: 100, outputTokens: 30 },
    } satisfies TextGenerationResponse),
    healthCheck: vi.fn(),
  };
}

const passages = [
  { id: 'p1', text: 'Paris is the capital of France. It was founded in the 3rd century BC.' },
  { id: 'p2', text: 'The Eiffel Tower is located in Paris and was completed in 1889.' },
];

describe('executeHop', () => {
  it('should return grounded hop result', async () => {
    const llm = mockLLM('The capital is clear.\nFINAL: Paris');
    const result = await executeHop('What is the capital of France?', passages, llm, 'hop1');

    expect(result.hop).toBeDefined();
    expect(result.hop!.answer).toBe('Paris');
    expect(result.hop!.grounded).toBe(true);
    expect(result.hop!.passageIds).toContain('p1');
    expect(result.fallbackReason).toBeUndefined();
  });

  it('fallback 5: should return hop1_empty on empty answer', async () => {
    const llm = mockLLM('FINAL: ');
    const result = await executeHop('Q?', passages, llm, 'hop1');
    expect(result.fallbackReason).toBe('hop1_empty');
    expect(result.hop).toBeUndefined();
  });

  it('fallback 7: should return hop2_empty on empty answer', async () => {
    const llm = mockLLM('   ');
    const result = await executeHop('Q?', passages, llm, 'hop2');
    expect(result.fallbackReason).toBe('hop2_empty');
  });

  it('fallback 6: should return hop1_ungrounded when answer not in passages', async () => {
    const llm = mockLLM('FINAL: Tokyo');
    const result = await executeHop('Q?', passages, llm, 'hop1');
    expect(result.fallbackReason).toBe('hop1_ungrounded');
    expect(result.hop).toBeDefined();
    expect(result.hop!.grounded).toBe(false);
  });

  it('fallback 8: should return hop2_ungrounded when answer not in passages', async () => {
    const llm = mockLLM('FINAL: Berlin');
    const result = await executeHop('Q?', passages, llm, 'hop2');
    expect(result.fallbackReason).toBe('hop2_ungrounded');
    expect(result.hop!.grounded).toBe(false);
  });

  it('should pass signal to LLM', async () => {
    const controller = new AbortController();
    const generateFn = vi.fn().mockResolvedValue({
      text: 'FINAL: Paris',
      model: 'test',
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const llm: ILLMProvider = { generate: generateFn, healthCheck: vi.fn() };

    await executeHop('Q?', passages, llm, 'hop1', controller.signal);

    expect(generateFn).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('should use medium effort for hop1 and high for hop2', async () => {
    const generateFn = vi.fn().mockResolvedValue({
      text: 'FINAL: Paris',
      model: 'test',
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const llm: ILLMProvider = { generate: generateFn, healthCheck: vi.fn() };

    await executeHop('Q?', passages, llm, 'hop1');
    expect(generateFn).toHaveBeenCalledWith(
      expect.objectContaining({ reasoningEffort: 'medium' }),
    );

    generateFn.mockClear();
    await executeHop('Q?', passages, llm, 'hop2');
    expect(generateFn).toHaveBeenCalledWith(
      expect.objectContaining({ reasoningEffort: 'high' }),
    );
  });

  it('should track usage correctly', async () => {
    const llm = mockLLM('FINAL: Paris');
    const result = await executeHop('Q?', passages, llm, 'hop1');
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(30);
  });
});
