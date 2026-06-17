import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUERY_FLAGS,
  DEFAULT_EVAL_FLAGS,
  DEFAULT_INDEXING_FLAGS,
  V15_BASELINE_QUERY_FLAGS,
  V03_ALL_ON_QUERY_FLAGS,
} from '../../../../src/domain/config/featureFlags.js';

describe('PLAN-003 T-001: QueryFeatureFlags', () => {
  it('default query flags are all OFF (v15 baseline)', () => {
    for (const value of Object.values(DEFAULT_QUERY_FLAGS)) {
      expect(value).toBe(false);
    }
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

  it('v0.3.0 all-on flags enable the expected features', () => {
    expect(V03_ALL_ON_QUERY_FLAGS.enableDictionaryInjection).toBe(true);
    expect(V03_ALL_ON_QUERY_FLAGS.enableThesaurusExpansion).toBe(true);
    expect(V03_ALL_ON_QUERY_FLAGS.enableHypernymExpansion).toBe(false);
    expect(V03_ALL_ON_QUERY_FLAGS.enableAliasHints).toBe(true);
    expect(V03_ALL_ON_QUERY_FLAGS.enableSubQueryDecomposition).toBe(true);
    expect(V03_ALL_ON_QUERY_FLAGS.enableComparisonVerification).toBe(true);
  });
});
