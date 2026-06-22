/**
 * Unit/Integration tests for T5d: MultiHopReasoner (full pipeline).
 * Covers: timeout fallback (9), LLM API error (10), self-consistency,
 * and full integration test for fallback precedence.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MultiHopReasoner } from '../../../src/application/query/MultiHopReasoner.js';
import type { ILLMProvider, TextGenerationRequest, TextGenerationResponse } from '../../../src/domain/provider/llmProvider.js';

const passages = [
  { id: 'p1', text: 'Christopher Nolan directed Inception and The Dark Knight.' },
  { id: 'p2', text: 'Inception was released in 2010 and stars Leonardo DiCaprio.' },
];

function createMockLLM(responses: string[]): ILLMProvider {
  let callIndex = 0;
  return {
    generate: vi.fn().mockImplementation(async (_req: TextGenerationRequest): Promise<TextGenerationResponse> => {
      const text = responses[callIndex] ?? responses[responses.length - 1]!;
      callIndex++;
      return { text, model: 'test', usage: { inputTokens: 50, outputTokens: 20 } };
    }),
    healthCheck: vi.fn(),
  };
}

describe('MultiHopReasoner', () => {
  describe('question type routing', () => {
    it('should skip multi-hop for comparison questions', async () => {
      const llm = createMockLLM(['should not be called']);
      const reasoner = new MultiHopReasoner(llm);
      const result = await reasoner.reason('Which is taller, Big Ben or the Eiffel Tower?', passages);
      expect(result.questionType).toBe('comparison');
      expect(result.fellBack).toBe(true);
      expect(result.usage.inputTokens).toBe(0);
    });

    it('should apply multi-hop for non-comparison questions (all treated as bridge)', async () => {
      // Simple questions now also go through multi-hop pipeline
      const llm = createMockLLM([
        JSON.stringify({
          hop1SubQuestion: 'What is the capital of France?',
          hop2SubQuestion: 'When was {hop1Answer} built?',
        }),
        'FINAL: Paris',
        'FINAL: unknown',
      ]);
      const reasoner = new MultiHopReasoner(llm);
      const result = await reasoner.reason('What is the capital of France?', passages);
      expect(result.questionType).toBe('bridge');
      // It will attempt multi-hop (LLM will be called)
      expect((llm.generate as any).mock.calls.length).toBeGreaterThan(0);
    });
  });

  describe('successful bridge reasoning', () => {
    it('should complete hop-1 → hop-2 pipeline', async () => {
      const llm = createMockLLM([
        // Decomposition
        JSON.stringify({
          hop1SubQuestion: 'Who directed Inception?',
          hop2SubQuestion: 'What other films did {hop1Answer} direct?',
        }),
        // Hop-1
        'The director is known.\nFINAL: Christopher Nolan',
        // Hop-2
        'FINAL: The Dark Knight',
      ]);
      const reasoner = new MultiHopReasoner(llm);
      const result = await reasoner.reason(
        'The person who directed Inception also directed what other film?',
        passages,
      );

      expect(result.questionType).toBe('bridge');
      expect(result.fellBack).toBe(false);
      expect(result.answer).toBe('The Dark Knight');
      expect(result.hop1!.answer).toBe('Christopher Nolan');
      expect(result.hop1!.grounded).toBe(true);
      expect(result.hop2!.answer).toBe('The Dark Knight');
    });
  });

  describe('fallback 9: timeout', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('should return timeout fallback when pipeline exceeds deadline', async () => {
      const llm: ILLMProvider = {
        generate: vi.fn().mockImplementation(() =>
          new Promise((resolve) => setTimeout(() => resolve({
            text: 'late',
            model: 'test',
            usage: { inputTokens: 10, outputTokens: 5 },
          }), 20000)),
        ),
        healthCheck: vi.fn(),
      };
      const reasoner = new MultiHopReasoner(llm);
      const promise = reasoner.reason(
        'The person who directed Inception also directed what?',
        passages,
        { timeoutMs: 1000 },
      );

      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;

      expect(result.fellBack).toBe(true);
      expect(result.fallbackReason).toBe('timeout');
    });
  });

  describe('fallback 10: LLM API error', () => {
    it('should return llm_api_error when LLM throws', async () => {
      const llm: ILLMProvider = {
        generate: vi.fn().mockRejectedValue(new Error('API rate limit')),
        healthCheck: vi.fn(),
      };
      const reasoner = new MultiHopReasoner(llm);
      const result = await reasoner.reason(
        'The person who directed Inception also directed what?',
        passages,
      );

      expect(result.fellBack).toBe(true);
      expect(result.fallbackReason).toBe('llm_api_error');
    });
  });

  describe('self-consistency', () => {
    it('should run multiple hop-2 attempts and use majority vote', async () => {
      const llm = createMockLLM([
        // Decomposition
        JSON.stringify({
          hop1SubQuestion: 'Who directed Inception?',
          hop2SubQuestion: 'What films did {hop1Answer} direct?',
        }),
        // Hop-1
        'FINAL: Christopher Nolan',
        // Hop-2 SC attempts
        'FINAL: The Dark Knight',
        'FINAL: The Dark Knight',
        'FINAL: Interstellar',
      ]);
      const reasoner = new MultiHopReasoner(llm);
      const result = await reasoner.reason(
        'The person who directed Inception also directed what?',
        passages,
        { enableSelfConsistency: true, selfConsistencyN: 3 },
      );

      expect(result.fellBack).toBe(false);
      expect(result.answer).toBe('The Dark Knight');
    });
  });

  describe('external abort', () => {
    it('should throw when external signal fires', async () => {
      const controller = new AbortController();
      const llm: ILLMProvider = {
        generate: vi.fn().mockImplementation(async () => {
          controller.abort();
          throw new Error('aborted');
        }),
        healthCheck: vi.fn(),
      };
      const reasoner = new MultiHopReasoner(llm);

      await expect(
        reasoner.reason(
          'The person who directed Inception also directed what?',
          passages,
          { signal: controller.signal },
        ),
      ).rejects.toThrow();
    });
  });

  describe('fallback precedence (integration)', () => {
    it('decomposition failures take precedence over hop failures', async () => {
      const llm = createMockLLM(['not valid json']);
      const reasoner = new MultiHopReasoner(llm);
      const result = await reasoner.reason(
        'The person who directed Inception also directed what?',
        passages,
      );
      expect(result.fallbackReason).toBe('decomposition_parse_error');
    });

    it('hop-1 failure takes precedence over hop-2', async () => {
      const llm = createMockLLM([
        JSON.stringify({
          hop1SubQuestion: 'Who directed it?',
          hop2SubQuestion: 'What did {hop1Answer} do?',
        }),
        'FINAL: ', // empty hop-1
      ]);
      const reasoner = new MultiHopReasoner(llm);
      const result = await reasoner.reason(
        'The person who directed Inception also directed what?',
        passages,
      );
      expect(result.fallbackReason).toBe('hop1_empty');
    });
  });

  describe('usage tracking', () => {
    it('should accumulate tokens from all steps', async () => {
      const llm = createMockLLM([
        JSON.stringify({
          hop1SubQuestion: 'Who directed Inception?',
          hop2SubQuestion: 'What did {hop1Answer} direct?',
        }),
        'FINAL: Christopher Nolan',
        'FINAL: The Dark Knight',
      ]);
      const reasoner = new MultiHopReasoner(llm);
      const result = await reasoner.reason(
        'The person who directed Inception also directed what?',
        passages,
      );

      // 3 LLM calls × (50 input + 20 output)
      expect(result.usage.inputTokens).toBe(150);
      expect(result.usage.outputTokens).toBe(60);
    });
  });
});
