/**
 * Tests for ComparisonVerifier (T-014).
 */
import { describe, it, expect, vi } from 'vitest';
import { ComparisonVerifier } from '../../../../src/application/query/ComparisonVerifier.js';
import type { ILLMProvider, TextGenerationResponse } from '../../../../src/domain/provider/index.js';

function mockLLM(response: string): ILLMProvider {
  return {
    generate: vi.fn().mockResolvedValue({
      text: response,
      model: 'test',
      usage: { inputTokens: 100, outputTokens: 50 },
    } satisfies TextGenerationResponse),
    healthCheck: vi.fn().mockResolvedValue({ healthy: true }),
  };
}

describe('ComparisonVerifier', () => {
  it('returns verified=true when initial response has comparison pattern', async () => {
    const verifier = new ComparisonVerifier(mockLLM('should not be called'));
    const result = await verifier.verify(
      'Entity A',
      'Entity A has 100 while Entity B has 50, so Entity A is the answer.',
      'Which is bigger?',
      'context',
      {},
    );
    expect(result.verified).toBe(true);
    expect(result.response).toBe('Entity A');
  });

  it('attempts regeneration when initial response lacks comparison', async () => {
    const llm = mockLLM('Entity A was founded in 1990 whereas Entity B was founded in 2000.\nFINAL: Entity A');
    const verifier = new ComparisonVerifier(llm);
    const result = await verifier.verify(
      'Entity A',
      'Entity A.',
      'Which was founded first?',
      'context',
      {},
    );
    expect(result.verified).toBe(true);
    expect(result.response).toBe('Entity A');
    expect(llm.generate).toHaveBeenCalled();
  });

  it('returns verified=false when regeneration also lacks comparison', async () => {
    const llm = mockLLM('Just the answer.');
    const verifier = new ComparisonVerifier(llm);
    const result = await verifier.verify(
      'Entity A',
      'Entity A.',
      'Which is bigger?',
      'context',
      {},
    );
    expect(result.verified).toBe(false);
    expect(result.response).toBe('Entity A');
  });

  it('returns initial answer on LLM error', async () => {
    const llm: ILLMProvider = {
      generate: vi.fn().mockRejectedValue(new Error('LLM down')),
      healthCheck: vi.fn().mockResolvedValue({ healthy: false }),
    };
    const verifier = new ComparisonVerifier(llm);
    const result = await verifier.verify(
      'Entity A',
      'Entity A.',
      'Which is bigger?',
      'context',
      {},
    );
    expect(result.verified).toBe(false);
    expect(result.response).toBe('Entity A');
  });
});
