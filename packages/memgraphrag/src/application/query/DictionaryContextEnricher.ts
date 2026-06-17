/**
 * Application Layer — Dictionary context enricher.
 * DES-MG3-010 (revised): Instead of injecting into PPR teleport vector,
 * enriches the LLM context with dictionary definitions and alias info.
 *
 * This avoids diluting the embedding-based seed quality while still
 * providing the LLM with disambiguation and entity knowledge.
 */

import type { ITermDictionary } from '../../domain/dictionary/termDictionary.js';
import type { LanguageCode } from '../../domain/memory/types.js';

/** Max dictionary hints to include in context */
const MAX_HINTS = parseInt(process.env.DICT_MAX_HINTS || '5');
/** Minimum confidence for dictionary entries */
const MIN_CONFIDENCE = parseFloat(process.env.DICT_MIN_CONFIDENCE || '0.7');

export interface DictionaryHint {
  readonly term: string;
  readonly canonicalForm: string;
  readonly aliases: readonly string[];
  readonly category: string;
}

export class DictionaryContextEnricher {
  constructor(
    private readonly dictionary: ITermDictionary,
    private readonly language: LanguageCode = 'en',
  ) {}

  /**
   * Extract dictionary hints for a query.
   * Returns structured hints that can be prepended to LLM context.
   */
  public async getHints(queryText: string): Promise<readonly DictionaryHint[]> {
    const matches = await this.dictionary.match(queryText, this.language);
    const valid = matches
      .filter((m) => m.entry.confidence >= MIN_CONFIDENCE)
      .sort((a, b) => b.entry.confidence - a.entry.confidence)
      .slice(0, MAX_HINTS);

    return valid.map((m) => ({
      term: m.matchedText,
      canonicalForm: m.entry.canonicalForm,
      aliases: m.entry.aliases,
      category: m.entry.domainCategory,
    }));
  }

  /**
   * Format hints as a context section string for LLM prompt.
   * Returns empty string if no relevant hints.
   */
  public formatHints(hints: readonly DictionaryHint[]): string {
    if (hints.length === 0) return '';

    const lines = hints.map((h) => {
      const parts = [`• ${h.canonicalForm}`];
      if (h.aliases.length > 0) {
        parts.push(`(also known as: ${h.aliases.slice(0, 3).join(', ')})`);
      }
      if (h.category) {
        parts.push(`[${h.category}]`);
      }
      return parts.join(' ');
    });

    return `\n[Entity Reference]\n${lines.join('\n')}\n`;
  }

  /**
   * One-shot: get hints and format them for the given query.
   */
  public async enrich(queryText: string): Promise<string> {
    const hints = await this.getHints(queryText);
    return this.formatHints(hints);
  }
}
