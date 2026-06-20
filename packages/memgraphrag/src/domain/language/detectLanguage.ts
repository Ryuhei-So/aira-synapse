/**
 * Language detection — detects text language based on character composition.
 * DES-006-003: CJK/kana → ja, else → en.
 */
import type { SupportedLanguage } from './LanguageStrategy.js';

// CJK Unified Ideographs + Hiragana + Katakana ranges
const CJK_REGEX = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\u3400-\u4DBF]/;

/**
 * Detect language of a text string.
 * Returns 'ja' if any CJK/kana characters are present, 'en' otherwise.
 */
export function detectLanguage(text: string): SupportedLanguage {
  return CJK_REGEX.test(text) ? 'ja' : 'en';
}
