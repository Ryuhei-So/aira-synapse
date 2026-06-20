/**
 * Japanese Language Strategy — JA-specific normalization and canonicalization.
 * DES-006-002: NFKC, fullwidth→halfwidth, katakana→hiragana, chouon normalization.
 */
import type { LanguageStrategy, SupportedLanguage } from './LanguageStrategy.js';

// Long-vowel characters to unify
const CHOUON_VARIANTS = /[−ｰ―]/g;
const CHOUON_UNIFIED = 'ー';

// Fullwidth alphanumeric → halfwidth
function fullwidthToHalfwidth(text: string): string {
  return text.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xFEE0),
  );
}

// Katakana → Hiragana (for canonical key comparison)
function katakanaToHiragana(text: string): string {
  return text.replace(/[\u30A1-\u30F6]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0x60),
  );
}

// Remove trailing chouon from katakana-derived text
function removeTrailingChouon(text: string): string {
  return text.replace(/ー$/g, '');
}

export class JapaneseLanguageStrategy implements LanguageStrategy {
  readonly language: SupportedLanguage = 'ja';

  normalizeText(text: string): string {
    let result = text.normalize('NFKC');
    result = fullwidthToHalfwidth(result);
    // Remove trailing chouon per word-like segment (for matching)
    result = result.replace(/[\u30A0-\u30FF]+/g, (katakana) =>
      katakana.replace(/ー$/, ''),
    );
    return result.trim();
  }

  canonicalKey(entityName: string): string {
    let key = entityName.normalize('NFKC');
    key = fullwidthToHalfwidth(key);
    key = key.replace(CHOUON_VARIANTS, CHOUON_UNIFIED);
    key = katakanaToHiragana(key);
    key = removeTrailingChouon(key);
    key = key.toLowerCase().replace(/\s+/g, ' ').trim();
    return key;
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length * 0.5);
  }
}
