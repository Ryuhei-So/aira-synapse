/**
 * Unit tests for Multi-hop domain types.
 * T1: Compile check + enum exhaustive validation.
 */
import { describe, it, expect } from 'vitest';
import type {
  QuestionType,
  MultiHopFallbackReason,
  Decomposition,
  HopResult,
  MultiHopResult,
  MultiHopOptions,
  IMultiHopReasoner,
} from '../../../src/domain/retrieval/multiHop.js';

describe('Multi-hop Domain Types', () => {
  describe('QuestionType', () => {
    it('should accept all valid values', () => {
      const types: QuestionType[] = ['bridge', 'comparison', 'simple'];
      expect(types).toHaveLength(3);
    });
  });

  describe('MultiHopFallbackReason', () => {
    it('should cover all 10 fallback conditions', () => {
      const reasons: MultiHopFallbackReason[] = [
        'decomposition_parse_error',
        'decomposition_missing_field',
        'decomposition_missing_placeholder',
        'decomposition_duplicate_hops',
        'hop1_empty',
        'hop1_ungrounded',
        'hop2_empty',
        'hop2_ungrounded',
        'timeout',
        'llm_api_error',
      ];
      expect(reasons).toHaveLength(10);
    });
  });

  describe('Decomposition', () => {
    it('should require hop1SubQuestion and hop2SubQuestion', () => {
      const d: Decomposition = {
        hop1SubQuestion: 'What is the capital of France?',
        hop2SubQuestion: 'When was {hop1Answer} founded?',
        bridgeEntityHint: 'city',
      };
      expect(d.hop1SubQuestion).toBeTruthy();
      expect(d.hop2SubQuestion).toContain('{hop1Answer}');
    });

    it('should allow optional bridgeEntityHint', () => {
      const d: Decomposition = {
        hop1SubQuestion: 'Q1',
        hop2SubQuestion: 'Q2 about {hop1Answer}',
      };
      expect(d.bridgeEntityHint).toBeUndefined();
    });
  });

  describe('HopResult', () => {
    it('should represent a hop answer with grounding', () => {
      const hop: HopResult = {
        answer: 'Paris',
        passageIds: ['p1', 'p2'],
        grounded: true,
      };
      expect(hop.grounded).toBe(true);
      expect(hop.passageIds).toHaveLength(2);
    });
  });

  describe('MultiHopResult', () => {
    it('should represent successful multi-hop', () => {
      const r: MultiHopResult = {
        answer: '1789',
        questionType: 'bridge',
        hop1: { answer: 'Paris', passageIds: ['p1'], grounded: true },
        hop2: { answer: '1789', passageIds: ['p2'], grounded: true },
        fellBack: false,
        latencyMs: 1500,
        usage: { inputTokens: 200, outputTokens: 50 },
      };
      expect(r.fellBack).toBe(false);
      expect(r.fallbackReason).toBeUndefined();
    });

    it('should represent fallback result', () => {
      const r: MultiHopResult = {
        answer: '',
        questionType: 'bridge',
        fellBack: true,
        fallbackReason: 'decomposition_parse_error',
        latencyMs: 200,
        usage: { inputTokens: 100, outputTokens: 10 },
      };
      expect(r.fellBack).toBe(true);
      expect(r.fallbackReason).toBe('decomposition_parse_error');
    });
  });

  describe('MultiHopOptions', () => {
    it('should accept all optional fields', () => {
      const opts: MultiHopOptions = {
        timeoutMs: 10000,
        enableSelfConsistency: true,
        selfConsistencyN: 3,
        signal: new AbortController().signal,
      };
      expect(opts.timeoutMs).toBe(10000);
    });
  });

  describe('IMultiHopReasoner', () => {
    it('should define the reason method contract', () => {
      const mock: IMultiHopReasoner = {
        async reason(query, passages, _options) {
          return {
            answer: 'test',
            questionType: 'bridge' as const,
            fellBack: false,
            latencyMs: 100,
            usage: { inputTokens: 0, outputTokens: 0 },
          };
        },
      };
      expect(mock.reason).toBeDefined();
    });
  });
});
