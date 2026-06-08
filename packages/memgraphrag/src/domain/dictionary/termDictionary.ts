/**
 * Domain Layer — Term Dictionary model and port.
 * DES-MG-006: Domain-specific term dictionary for extraction boost.
 */

import type { LanguageCode, Timestamped } from '../memory/types.js';

export type DictionarySource = 'api' | 'manual' | 'extracted' | 'approved_candidate';

export interface TermDictionaryEntry extends Timestamped {
  readonly termId: string;
  readonly term: string;
  readonly canonicalForm: string;
  readonly domainCategory: string;
  readonly aliases: readonly string[];
  readonly frequency: number;
  readonly confidence: number;
  readonly source: DictionarySource;
  readonly version: string;
}

export interface DictionaryMatch {
  readonly entry: TermDictionaryEntry;
  readonly matchedText: string;
  readonly boostFactor: number;
}

export interface DictionaryStatistics {
  readonly totalTerms: number;
  readonly domains: Readonly<Record<string, number>>;
  readonly boostAppliedRate: number;
  readonly discoveredTermCount: number;
}

export interface ITermDictionary {
  upsertEntries(entries: readonly TermDictionaryEntry[]): Promise<void>;
  match(text: string, language: LanguageCode): Promise<readonly DictionaryMatch[]>;
  suggest(
    entries: readonly string[],
    frequencyThreshold: number,
  ): Promise<readonly TermDictionaryEntry[]>;
  exportJson(): Promise<Readonly<Record<string, unknown>>>;
  importJson(data: Readonly<Record<string, unknown>>): Promise<void>;
  getStatistics(): Promise<DictionaryStatistics>;
}
