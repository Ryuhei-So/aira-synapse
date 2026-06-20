/**
 * Language Strategy — abstraction for language-specific text processing.
 * DES-006-001: Supports extensible multi-language handling via Strategy pattern.
 */

export type SupportedLanguage = 'ja' | 'en';

export interface LanguageStrategy {
  readonly language: SupportedLanguage;
  /** Normalize text for matching/indexing (FR-003) */
  normalizeText(text: string): string;
  /** Generate canonical key for entity deduplication (FR-004) */
  canonicalKey(entityName: string): string;
  /** Estimate token count for chunking decisions (FR-006) */
  estimateTokens(text: string): number;
}

/**
 * English language strategy — preserves current behavior.
 */
export class EnglishLanguageStrategy implements LanguageStrategy {
  readonly language: SupportedLanguage = 'en';

  normalizeText(text: string): string {
    return text.toLowerCase().trim();
  }

  canonicalKey(entityName: string): string {
    return entityName.toLowerCase().replace(/\s+/g, ' ').trim();
  }

  estimateTokens(text: string): number {
    return text.split(/\s+/).filter(Boolean).length;
  }
}
