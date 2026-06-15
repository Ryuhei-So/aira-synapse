/**
 * Domain Layer — Feature flags for v0.3.0 query accuracy improvements.
 * DES-MG3-009: Granular control over dictionary, thesaurus, sub-query,
 * comparison verification, and eval normalization features.
 */

export interface QueryFeatureFlags {
  readonly enableDictionaryInjection: boolean;
  readonly enableThesaurusExpansion: boolean;
  readonly enableHypernymExpansion: boolean;
  readonly enableAliasHints: boolean;
  readonly enableSubQueryDecomposition: boolean;
  readonly enableComparisonVerification: boolean;
}

export interface EvalFeatureFlags {
  readonly enableEvalAliasNormalization: boolean;
}

export interface IndexingFeatureFlags {
  readonly enableDictionaryIndexing: boolean;
}

export const DEFAULT_QUERY_FLAGS: Readonly<QueryFeatureFlags> = {
  enableDictionaryInjection: true,
  enableThesaurusExpansion: true,
  enableHypernymExpansion: false,
  enableAliasHints: true,
  enableSubQueryDecomposition: true,
  enableComparisonVerification: true,
};

export const DEFAULT_EVAL_FLAGS: Readonly<EvalFeatureFlags> = {
  enableEvalAliasNormalization: true,
};

export const DEFAULT_INDEXING_FLAGS: Readonly<IndexingFeatureFlags> = {
  enableDictionaryIndexing: true,
};

/** All query flags disabled — v15 backward compatibility mode. */
export const V15_BASELINE_QUERY_FLAGS: Readonly<QueryFeatureFlags> = {
  enableDictionaryInjection: false,
  enableThesaurusExpansion: false,
  enableHypernymExpansion: false,
  enableAliasHints: false,
  enableSubQueryDecomposition: false,
  enableComparisonVerification: false,
};
