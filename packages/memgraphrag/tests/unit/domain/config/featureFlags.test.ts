import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUERY_FLAGS,
  DEFAULT_EVAL_FLAGS,
  DEFAULT_INDEXING_FLAGS,
  V15_BASELINE_QUERY_FLAGS,
} from '../../../../src/domain/config/featureFlags.js';

describe('PLAN-003 T-001: QueryFeatureFlags', () => {
  it('has correct default query flags', () => {
    expect(DEFAULT_QUERY_FLAGS.enableDictionaryInjection).toBe(true);
    expect(DEFAULT_QUERY_FLAGS.enableThesaurusExpansion).toBe(true);
    expect(DEFAULT_QUERY_FLAGS.enableHypernymExpansion).toBe(false);
    expect(DEFAULT_QUERY_FLAGS.enableAliasHints).toBe(true);
    expect(DEFAULT_QUERY_FLAGS.enableSubQueryDecomposition).toBe(true);
    expect(DEFAULT_QUERY_FLAGS.enableComparisonVerification).toBe(true);
  });

  it('has correct default eval flags', () => {
    expect(DEFAULT_EVAL_FLAGS.enableEvalAliasNormalization).toBe(true);
  });

  it('has correct default indexing flags', () => {
    expect(DEFAULT_INDEXING_FLAGS.enableDictionaryIndexing).toBe(true);
  });

  it('v15 baseline has all query flags disabled', () => {
    for (const value of Object.values(V15_BASELINE_QUERY_FLAGS)) {
      expect(value).toBe(false);
    }
  });
});
