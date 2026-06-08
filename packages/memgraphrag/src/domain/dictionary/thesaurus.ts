/**
 * Domain Layer — Thesaurus model and port.
 * DES-MG-007: Synonym/hypernym/hyponym relations for schema normalization.
 */

import type { LanguageCode, Timestamped } from '../memory/types.js';

export type ThesaurusRelationType = 'synonym' | 'hypernym' | 'hyponym' | 'related';

const RELATION_TYPES = new Set<string>([
  'synonym', 'hypernym', 'hyponym', 'related',
]);

export function isThesaurusRelationType(
  value: unknown,
): value is ThesaurusRelationType {
  return typeof value === 'string' && RELATION_TYPES.has(value);
}

export interface ThesaurusRelation extends Timestamped {
  readonly relationId: string;
  readonly sourceTerm: string;
  readonly targetTerm: string;
  readonly relationType: ThesaurusRelationType;
  readonly language: LanguageCode;
  readonly weight: number;
  readonly bidirectional: boolean;
}

export interface NormalizationResult {
  readonly canonicalTerm: string;
  readonly originalTerm: string;
  readonly appliedRelations: readonly ThesaurusRelation[];
}

export interface QueryExpansion {
  readonly originalQuery: string;
  readonly expandedTerms: readonly string[];
  readonly rewrittenQuery: string;
}

export interface IThesaurus {
  normalize(term: string, language: LanguageCode): Promise<NormalizationResult>;
  expandQuery(query: string, limit: number): Promise<QueryExpansion>;
  getRelations(term: string): Promise<readonly ThesaurusRelation[]>;
  suggestSynonyms(
    pairs: readonly [string, string][],
  ): Promise<readonly ThesaurusRelation[]>;
  exportJson(): Promise<Readonly<Record<string, unknown>>>;
  importJson(data: Readonly<Record<string, unknown>>): Promise<void>;
}
