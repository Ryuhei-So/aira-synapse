/**
 * Unit tests for T4a: deterministic multi-hop helpers.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyQuestion,
  normalizeForGrounding,
  hopSimilarity,
} from '../../../src/application/query/multiHopHelpers.js';

describe('classifyQuestion', () => {
  it('should classify comparison questions', () => {
    expect(classifyQuestion('Which is taller, the Eiffel Tower or Big Ben?')).toBe('comparison');
    expect(classifyQuestion('Are both teams from the same country?')).toBe('comparison');
    expect(classifyQuestion('Who is older, Alice or Bob?')).toBe('comparison');
  });

  it('should classify bridge questions', () => {
    expect(classifyQuestion('The person who directed Inception also directed what other film?')).toBe('bridge');
    expect(classifyQuestion('Where did the man who founded Apple go to school?')).toBe('bridge');
    expect(classifyQuestion('The city that hosted the 2012 Olympics was founded in what year?')).toBe('bridge');
  });

  it('should classify simple questions as simple', () => {
    expect(classifyQuestion('What is the capital of France?')).toBe('simple');
    expect(classifyQuestion('When was Einstein born?')).toBe('simple');
  });

  it('should prioritize comparison over bridge', () => {
    // A question that could match both patterns — comparison wins
    expect(classifyQuestion('Which city that hosted the Olympics is older, London or Tokyo?')).toBe('comparison');
  });
});

describe('normalizeForGrounding', () => {
  it('should lowercase and strip punctuation', () => {
    expect(normalizeForGrounding('Hello, World!')).toBe('hello world');
  });

  it('should collapse whitespace', () => {
    expect(normalizeForGrounding('  multiple   spaces  ')).toBe('multiple spaces');
  });

  it('should handle empty string', () => {
    expect(normalizeForGrounding('')).toBe('');
  });

  it('should preserve numbers', () => {
    expect(normalizeForGrounding('Year 2024!')).toBe('year 2024');
  });
});

describe('hopSimilarity', () => {
  it('should return 1.0 for identical strings', () => {
    expect(hopSimilarity('Paris', 'Paris')).toBe(1.0);
  });

  it('should return 1.0 for short answer substring match', () => {
    expect(hopSimilarity('Paris', 'The capital is Paris, France')).toBe(1.0);
  });

  it('should return 0 for no overlap', () => {
    expect(hopSimilarity('apple', 'banana orange grape')).toBe(0);
  });

  it('should return 0 for empty inputs', () => {
    expect(hopSimilarity('', 'something')).toBe(0);
    expect(hopSimilarity('something', '')).toBe(0);
  });

  it('should compute Jaccard for longer texts', () => {
    const a = 'the quick brown fox jumps';
    const b = 'the quick red fox runs';
    // Intersection: the, quick, fox = 3
    // Union: the, quick, brown, fox, jumps, red, runs = 7
    expect(hopSimilarity(a, b)).toBeCloseTo(3 / 7, 5);
  });

  it('should use substring for short answers (≤3 words)', () => {
    expect(hopSimilarity('New York', 'He lived in New York for years')).toBe(1.0);
    expect(hopSimilarity('New York', 'He lived in Los Angeles')).toBe(0);
  });
});
