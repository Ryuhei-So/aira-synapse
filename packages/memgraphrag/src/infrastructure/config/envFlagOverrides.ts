/**
 * Infrastructure Layer — Environment variable overrides for feature flags.
 * DES-MG4-007: Allows runtime flag control via environment variables.
 */

import type { QueryFeatureFlags } from '../../domain/config/featureFlags.js';

const ENV_FLAG_MAP: Record<string, keyof QueryFeatureFlags> = {
  'QUERY_REWRITE': 'enableQueryRewriting',
  'PASSAGE_RERANK': 'enablePassageReranking',
  'COMPARISON_REASONING': 'enableComparisonReasoning',
  'ANSWER_NORMALIZATION': 'enableAnswerNormalization',
  'DICTIONARY_INJECTION': 'enableDictionaryInjection',
  'THESAURUS_EXPANSION': 'enableThesaurusExpansion',
  'HYPERNYM_EXPANSION': 'enableHypernymExpansion',
  'ALIAS_HINTS': 'enableAliasHints',
  'SUB_QUERY_DECOMPOSITION': 'enableSubQueryDecomposition',
  'COMPARISON_VERIFICATION': 'enableComparisonVerification',
};

/**
 * Apply environment variable overrides to feature flags.
 * Environment variables: set to "true" or "1" to enable, "false" or "0" to disable.
 * Unset variables leave the flag unchanged.
 */
export function applyEnvOverrides(flags: QueryFeatureFlags): QueryFeatureFlags {
  const overrides: Partial<Record<keyof QueryFeatureFlags, boolean>> = {};

  for (const [envKey, flagKey] of Object.entries(ENV_FLAG_MAP)) {
    const val = process.env[envKey];
    if (val !== undefined) {
      overrides[flagKey] = val === 'true' || val === '1';
    }
  }

  if (Object.keys(overrides).length === 0) {
    return flags;
  }

  return { ...flags, ...overrides };
}
