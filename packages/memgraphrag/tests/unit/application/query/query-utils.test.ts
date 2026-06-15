import { describe, expect, it } from 'vitest';
import {
  extractFinalAnswer,
  escapeRegex,
  withTimeout,
} from '../../../../src/application/query/query-utils.js';

describe('PLAN-003 T-005: query-utils', () => {
  describe('extractFinalAnswer', () => {
    it('extracts FINAL: line', () => {
      const text = 'Some reasoning\nFINAL: The answer is 42\nExtra text';
      expect(extractFinalAnswer(text)).toBe('The answer is 42');
    });

    it('falls back to last line when no FINAL:', () => {
      const text = 'Line 1\nLine 2\nThe actual answer';
      expect(extractFinalAnswer(text)).toBe('The actual answer');
    });

    it('strips quotes', () => {
      const text = 'FINAL: "Lord Byron"';
      expect(extractFinalAnswer(text)).toBe('Lord Byron');
    });

    it('handles single line', () => {
      expect(extractFinalAnswer('Yes')).toBe('Yes');
    });

    it('handles empty string', () => {
      expect(extractFinalAnswer('')).toBe('');
    });
  });

  describe('escapeRegex', () => {
    it('escapes special regex characters', () => {
      expect(escapeRegex('a.b*c+d')).toBe('a\\.b\\*c\\+d');
    });

    it('escapes brackets and parens', () => {
      expect(escapeRegex('(test)[0]')).toBe('\\(test\\)\\[0\\]');
    });

    it('passes through normal text', () => {
      expect(escapeRegex('hello world')).toBe('hello world');
    });
  });

  describe('withTimeout', () => {
    it('returns result when promise resolves before timeout', async () => {
      const result = await withTimeout(Promise.resolve('ok'), 1000);
      expect(result).toBe('ok');
    });

    it('returns null when promise takes longer than timeout', async () => {
      const slowPromise = new Promise<string>((resolve) =>
        setTimeout(() => resolve('too late'), 500),
      );
      const result = await withTimeout(slowPromise, 10);
      expect(result).toBeNull();
    });

    it('returns result for immediate resolution', async () => {
      const result = await withTimeout(Promise.resolve(42), 0);
      // Promise.resolve is microtask, resolves before setTimeout(0)
      expect(result).toBe(42);
    });
  });
});
