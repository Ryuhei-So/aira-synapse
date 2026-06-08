/**
 * Infrastructure Layer — Regex-based NLP fallback extractor.
 * DES-MG-036: Local-only extraction for degraded mode.
 */

import type { INLPExtractor, NlpExtractionRequest, NlpExtractionResponse, NlpEntity, ProviderHealth } from '../../domain/provider/llmProvider.js';

// English: Title Case words, acronyms, hyphenated compounds
const EN_TITLE_CASE = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g;
const EN_ACRONYM = /\b[A-Z]{2,6}\b/g;
const EN_HYPHENATED = /\b[A-Za-z]+-[A-Za-z]+(?:-[A-Za-z]+)*\b/g;

// Japanese: consecutive katakana, kanji compounds
const JA_KATAKANA = /[\u30A0-\u30FF]{2,}/g;
const JA_KANJI_COMPOUND = /[\u4E00-\u9FFF]{2,}/g;

export class RegexExtractor implements INLPExtractor {
  async extract(request: NlpExtractionRequest): Promise<NlpExtractionResponse> {
    const { text, language } = request;
    const entities: NlpEntity[] = [];
    const nounPhrases: string[] = [];

    if (language === 'en' || language === 'mixed') {
      this.extractPatterns(text, EN_TITLE_CASE, 'ENTITY', entities);
      this.extractPatterns(text, EN_ACRONYM, 'ACRONYM', entities);
      this.extractPatterns(text, EN_HYPHENATED, 'COMPOUND', entities);
      nounPhrases.push(...this.extractNounPhrases(text, EN_TITLE_CASE));
    }

    if (language === 'ja' || language === 'mixed') {
      this.extractPatterns(text, JA_KATAKANA, 'KATAKANA', entities);
      this.extractPatterns(text, JA_KANJI_COMPOUND, 'KANJI_COMPOUND', entities);
    }

    // Deduplicate entities by text
    const seen = new Set<string>();
    const deduplicated = entities.filter((e) => {
      if (seen.has(e.text)) return false;
      seen.add(e.text);
      return true;
    });

    return {
      language,
      entities: deduplicated,
      nounPhrases: [...new Set(nounPhrases)],
    };
  }

  async healthCheck(): Promise<ProviderHealth> {
    return { healthy: true, message: 'RegexExtractor is always available' };
  }

  private extractPatterns(
    text: string,
    pattern: RegExp,
    label: string,
    entities: NlpEntity[],
  ): void {
    // Reset regex state
    const regex = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      entities.push({
        text: match[0],
        label,
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }

  private extractNounPhrases(text: string, pattern: RegExp): string[] {
    const regex = new RegExp(pattern.source, pattern.flags);
    const phrases: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      phrases.push(match[0]);
    }
    return phrases;
  }
}
