/**
 * Domain Layer — Feature flags for query accuracy improvements.
 * DES-MG3-009: v0.3.0 dictionary/thesaurus features (all OFF — proven regression).
 * DES-MG4-007: Phase 2 query rewriting, reranking, comparison reasoning, normalization.
 */

export interface QueryFeatureFlags {
  // --- v0.3.0 flags (all OFF by default — ablation showed -3.4% regression) ---
  readonly enableDictionaryInjection: boolean;
  readonly enableThesaurusExpansion: boolean;
  readonly enableHypernymExpansion: boolean;
  readonly enableAliasHints: boolean;
  readonly enableSubQueryDecomposition: boolean;   // deprecated: use enableQueryRewriting
  readonly enableComparisonVerification: boolean;  // deprecated: use enableComparisonReasoning

  // --- Phase 2 flags (all OFF by default — opt-in after ablation) ---
  readonly enableQueryRewriting: boolean;          // Phase 2a: multi-hop query decomposition
  readonly enablePassageReranking: boolean;        // Phase 2b: LLM-based passage reranking
  readonly enableComparisonReasoning: boolean;     // Phase 1a: Yes/No comparison reasoning
  readonly enableAnswerNormalization: boolean;     // Phase 1b: answer normalization prompt
}

export interface EvalFeatureFlags {
  readonly enableEvalAliasNormalization: boolean;
}

export interface IndexingFeatureFlags {
  readonly enableDictionaryIndexing: boolean;
}

/**
 * Default query flags — v15 baseline (all features OFF).
 * v0.3.0 features: proven regression (-3.4%).
 * Phase 2 features: opt-in after ablation testing.
 */
export const DEFAULT_QUERY_FLAGS: Readonly<QueryFeatureFlags> = {
  // v0.3.0 (all OFF)
  enableDictionaryInjection: false,
  enableThesaurusExpansion: false,
  enableHypernymExpansion: false,
  enableAliasHints: false,
  enableSubQueryDecomposition: false,
  enableComparisonVerification: false,
  // Phase 2 (all OFF)
  enableQueryRewriting: false,
  enablePassageReranking: false,
  enableComparisonReasoning: false,
  enableAnswerNormalization: false,
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
  enableQueryRewriting: false,
  enablePassageReranking: false,
  enableComparisonReasoning: false,
  enableAnswerNormalization: false,
};

/** All v0.3.0 query flags enabled — for ablation and future tuning. */
export const V03_ALL_ON_QUERY_FLAGS: Readonly<QueryFeatureFlags> = {
  enableDictionaryInjection: true,
  enableThesaurusExpansion: true,
  enableHypernymExpansion: false,
  enableAliasHints: true,
  enableSubQueryDecomposition: true,
  enableComparisonVerification: true,
  enableQueryRewriting: false,
  enablePassageReranking: false,
  enableComparisonReasoning: false,
  enableAnswerNormalization: false,
};

/**
 * Phase 2 promoted configuration — based on ablation testing results.
 *
 * Ablation summary (500q HotpotQA, v15 baseline = 90.0%):
 * - enableComparisonReasoning: comparison +4% (94/100), but bridge -2.7% → net -1.4%
 * - enableAnswerNormalization: -1.0% overall (bridge degradation)
 * - Both combined: -1.0% overall
 *
 * Conclusion: LLM answer variance (GPT-5 non-determinism) causes more regression
 * on bridge questions than the improvement on comparison. Phase 2a/2b features
 * (query rewriting, passage reranking) remain experimental pending further tuning.
 *
 * All flags OFF for production safety. Enable selectively for experimentation.
 */
export const PROMOTED_PHASE2_FLAGS: Partial<QueryFeatureFlags> = {
  enableComparisonReasoning: false,   // +4% comparison, but -2.7% bridge → net negative
  enableAnswerNormalization: false,   // proven -1% regression
  enableQueryRewriting: false,        // untested at scale (T-015 pending)
  enablePassageReranking: false,      // untested at scale (T-018 pending)
};
