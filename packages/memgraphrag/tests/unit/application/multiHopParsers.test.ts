/**
 * Unit tests for T4b: LLM output parsing helpers.
 */
import { describe, it, expect } from 'vitest';
import {
  parseHopOutput,
  validateGrounding,
  majorityVote,
} from '../../../src/application/query/multiHopParsers.js';
import type { HopResult } from '../../../src/domain/retrieval/multiHop.js';

describe('parseHopOutput', () => {
  it('should extract answer from FINAL: line', () => {
    const text = 'Some reasoning...\nFINAL: Paris';
    expect(parseHopOutput(text)).toBe('Paris');
  });

  it('should strip quotes from FINAL answer', () => {
    expect(parseHopOutput('FINAL: "London"')).toBe('London');
  });

  it('should fall back to last non-empty line', () => {
    const text = 'Step 1: thinking\nStep 2: more thinking\nTokyo';
    expect(parseHopOutput(text)).toBe('Tokyo');
  });

  it('should handle single-line response', () => {
    expect(parseHopOutput('Berlin')).toBe('Berlin');
  });

  it('should handle empty string', () => {
    expect(parseHopOutput('')).toBe('');
  });
});

describe('validateGrounding', () => {
  const passages = [
    { id: 'p1', text: 'Paris is the capital of France, founded in 3rd century BC.' },
    { id: 'p2', text: 'London is the capital of England and the United Kingdom.' },
  ];

  it('should validate grounded answer (exact substring)', () => {
    const result = validateGrounding('Paris', passages);
    expect(result.grounded).toBe(true);
    expect(result.passageIds).toContain('p1');
  });

  it('should reject ungrounded answer', () => {
    const result = validateGrounding('Tokyo', passages);
    expect(result.grounded).toBe(false);
    expect(result.passageIds).toHaveLength(0);
  });

  it('should handle empty answer', () => {
    const result = validateGrounding('', passages);
    expect(result.grounded).toBe(false);
  });

  it('should match via word-overlap for multi-word answers', () => {
    // "capital France" has both words in p1 ("Paris is the capital of France")
    const result = validateGrounding('capital of France', passages);
    expect(result.grounded).toBe(true);
  });

  it('should match significant words for short multi-word answers', () => {
    // "Lost Highway" — both words (≥4 chars) appear in passage
    const result = validateGrounding('Lost Highway', [
      { id: 'p1', text: 'Paris is the capital' },
      { id: 'p2', text: 'Lost Highway Records is a Nashville-based record label' },
    ]);
    expect(result.grounded).toBe(true);
    expect(result.passageIds).toContain('p2');
  });

  it('should use word-boundary for short answers (≤3 chars)', () => {
    const shortPassages = [
      { id: 's1', text: 'The answer is yes definitely.' },
      { id: 's2', text: 'Analysis of the yes vote.' },
    ];
    const result = validateGrounding('yes', shortPassages);
    expect(result.grounded).toBe(true);
  });

  it('should not match partial word for short answers', () => {
    const shortPassages = [
      { id: 's1', text: 'The eyes of the owl.' },
    ];
    // "yes" should NOT match "eyes"
    const result = validateGrounding('yes', shortPassages);
    expect(result.grounded).toBe(false);
  });
});

describe('majorityVote', () => {
  it('should return most frequent answer', () => {
    const candidates: HopResult[] = [
      { answer: 'Paris', passageIds: ['p1'], grounded: true },
      { answer: 'London', passageIds: ['p2'], grounded: true },
      { answer: 'Paris', passageIds: ['p3'], grounded: true },
    ];
    const result = majorityVote(candidates);
    expect(result.answer).toBe('Paris');
  });

  it('should merge passage IDs from winner', () => {
    const candidates: HopResult[] = [
      { answer: 'Paris', passageIds: ['p1'], grounded: true },
      { answer: 'Paris', passageIds: ['p2', 'p3'], grounded: true },
    ];
    const result = majorityVote(candidates);
    expect(result.passageIds).toEqual(expect.arrayContaining(['p1', 'p2', 'p3']));
  });

  it('should handle case-insensitive matching', () => {
    const candidates: HopResult[] = [
      { answer: 'paris', passageIds: ['p1'], grounded: true },
      { answer: 'Paris', passageIds: ['p2'], grounded: true },
      { answer: 'PARIS', passageIds: ['p3'], grounded: true },
    ];
    const result = majorityVote(candidates);
    // All normalize to same — first original preserved
    expect(normalizeAnswer(result.answer)).toBe('paris');
    expect(result.passageIds).toHaveLength(3);
  });

  it('should handle empty candidates', () => {
    const result = majorityVote([]);
    expect(result.answer).toBe('');
    expect(result.passageIds).toHaveLength(0);
  });

  it('should handle tie by picking first encountered', () => {
    const candidates: HopResult[] = [
      { answer: 'A', passageIds: ['p1'], grounded: true },
      { answer: 'B', passageIds: ['p2'], grounded: true },
    ];
    const result = majorityVote(candidates);
    // Both have count 1, first wins
    expect(['A', 'B']).toContain(result.answer);
  });
});

function normalizeAnswer(text: string): string {
  return text.toLowerCase().trim();
}
