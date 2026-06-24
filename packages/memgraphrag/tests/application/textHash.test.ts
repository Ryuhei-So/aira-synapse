import { describe, it, expect } from 'vitest';
import {
  normalizeTextForDedup,
  computeTextHash,
  computePassageDedupeKey,
} from '../../src/application/query/textHash.js';

describe('textHash', () => {
  describe('normalizeTextForDedup', () => {
    it('collapses whitespace and trims', () => {
      expect(normalizeTextForDedup('  hello   world  ')).toBe('hello world');
    });

    it('lowercases text', () => {
      expect(normalizeTextForDedup('Hello World')).toBe('hello world');
    });

    it('handles empty string', () => {
      expect(normalizeTextForDedup('')).toBe('');
    });

    it('normalizes tabs and newlines', () => {
      expect(normalizeTextForDedup('a\t\nb')).toBe('a b');
    });
  });

  describe('computeTextHash', () => {
    it('returns 16 hex chars', () => {
      const hash = computeTextHash('test text');
      expect(hash).toHaveLength(16);
      expect(hash).toMatch(/^[0-9a-f]{16}$/);
    });

    it('is deterministic', () => {
      expect(computeTextHash('same text')).toBe(computeTextHash('same text'));
    });

    it('ignores whitespace differences', () => {
      expect(computeTextHash('hello world')).toBe(computeTextHash('hello   world'));
    });

    it('ignores case differences', () => {
      expect(computeTextHash('Hello')).toBe(computeTextHash('hello'));
    });

    it('differs for different text', () => {
      expect(computeTextHash('text a')).not.toBe(computeTextHash('text b'));
    });
  });

  describe('computePassageDedupeKey', () => {
    it('combines sourceUrl and text hash', () => {
      const key = computePassageDedupeKey('http://example.com', 'some text');
      expect(key).toContain('http://example.com::');
      expect(key.split('::')[1]).toHaveLength(16);
    });

    it('same url + same text = same key', () => {
      const k1 = computePassageDedupeKey('http://a.com', 'text');
      const k2 = computePassageDedupeKey('http://a.com', 'text');
      expect(k1).toBe(k2);
    });

    it('same url + different text = different key', () => {
      const k1 = computePassageDedupeKey('http://a.com', 'text 1');
      const k2 = computePassageDedupeKey('http://a.com', 'text 2');
      expect(k1).not.toBe(k2);
    });

    it('different url + same text = different key', () => {
      const k1 = computePassageDedupeKey('http://a.com', 'text');
      const k2 = computePassageDedupeKey('http://b.com', 'text');
      expect(k1).not.toBe(k2);
    });
  });
});
