import { describe, expect, it } from 'vitest';
import { EnglishLanguageStrategy } from '../../../../src/domain/language/LanguageStrategy.js';
import { JapaneseLanguageStrategy } from '../../../../src/domain/language/JapaneseLanguageStrategy.js';

describe('language strategy boundaries', () => {
  describe('EnglishLanguageStrategy', () => {
    const strategy = new EnglishLanguageStrategy();

    it('normalizes matching text and canonical keys independently', () => {
      expect(strategy.language).toBe('en');
      expect(strategy.normalizeText('  Mixed CASE text  ')).toBe('mixed case text');
      expect(strategy.canonicalKey('  Mixed   CASE text  ')).toBe('mixed case text');
    });

    it('counts non-empty whitespace-delimited tokens', () => {
      expect(strategy.estimateTokens(' one\t two\nthree ')).toBe(3);
      expect(strategy.estimateTokens('   ')).toBe(0);
    });
  });

  describe('JapaneseLanguageStrategy', () => {
    const strategy = new JapaneseLanguageStrategy();

    it('normalizes NFKC text and removes trailing long vowels per katakana segment', () => {
      expect(strategy.language).toBe('ja');
      expect(strategy.normalizeText('  ＡＢＣ　カー キー テスト  ')).toBe(
        'ABC カ キ テスト',
      );
    });

    it('builds canonical keys across width, long-vowel, script, and whitespace variants', () => {
      expect(strategy.canonicalKey('  ＡＢＣ　カタカー− テストｰ―  ')).toBe(
        'abc かたかーー てすとーー',
      );
      expect(strategy.canonicalKey('No-Katakana  Name')).toBe('no-katakana name');
    });

    it('estimates Japanese tokens from text length', () => {
      expect(strategy.estimateTokens('日本語abc')).toBe(3);
      expect(strategy.estimateTokens('日本語')).toBe(2);
      expect(strategy.estimateTokens('')).toBe(0);
    });
  });
});
