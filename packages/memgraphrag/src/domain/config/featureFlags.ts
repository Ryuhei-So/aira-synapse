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
  readonly enableMultiHopReasoning: boolean;
}

/**
 * Canonical v15 support witness for every query feature flag.
 *
 * The mapped-type `satisfies` clause makes adding a QueryFeatureFlags field
 * without classifying it here a compile error.  The retrieval plan derives
 * its runtime unsupported set from this map rather than maintaining a second
 * hand-written key list.
 */
export const V15_QUERY_FEATURE_SUPPORT = {
  enableAliasHints: false,
  enableComparisonVerification: false,
  enableDictionaryInjection: false,
  enableHypernymExpansion: false,
  enableMultiHopReasoning: false,
  enableSubQueryDecomposition: false,
  enableThesaurusExpansion: false,
} as const satisfies { readonly [K in keyof QueryFeatureFlags]: boolean };

export interface EvalFeatureFlags {
  readonly enableEvalAliasNormalization: boolean;
}

export interface IndexingFeatureFlags {
  readonly enableDictionaryIndexing: boolean;
}

/**
 * Default query flags — v15 baseline (all v0.3.0 features OFF).
 * Ablation testing showed v0.3.0 features cause regression:
 *   v15 baseline: 88.4% vs v0.3.0 all-on: 85.0% (-3.4%)
 * Features are preserved for future tuning but disabled by default.
 */
export const DEFAULT_QUERY_FLAGS: Readonly<QueryFeatureFlags> = {
  enableDictionaryInjection: false,
  enableThesaurusExpansion: false,
  enableHypernymExpansion: false,
  enableAliasHints: false,
  enableSubQueryDecomposition: false,
  enableComparisonVerification: false,
  enableMultiHopReasoning: false,
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
  enableMultiHopReasoning: false,
};

/** All v0.3.0 query flags enabled — for ablation and future tuning. */
export const V03_ALL_ON_QUERY_FLAGS: Readonly<QueryFeatureFlags> = {
  enableDictionaryInjection: true,
  enableThesaurusExpansion: true,
  enableHypernymExpansion: false,
  enableAliasHints: true,
  enableSubQueryDecomposition: true,
  enableComparisonVerification: true,
  enableMultiHopReasoning: true,
};
