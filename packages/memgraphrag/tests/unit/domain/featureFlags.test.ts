/**
 * Unit tests for feature flag changes (T3).
 * Validates enableMultiHopReasoning in all presets.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_QUERY_FLAGS,
  V15_BASELINE_QUERY_FLAGS,
  V03_ALL_ON_QUERY_FLAGS,
} from '../../../src/domain/config/featureFlags.js';

describe('Feature Flags — enableMultiHopReasoning', () => {
  it('DEFAULT_QUERY_FLAGS has enableMultiHopReasoning = false', () => {
    expect(DEFAULT_QUERY_FLAGS.enableMultiHopReasoning).toBe(false);
  });

  it('V15_BASELINE_QUERY_FLAGS has enableMultiHopReasoning = false', () => {
    expect(V15_BASELINE_QUERY_FLAGS.enableMultiHopReasoning).toBe(false);
  });

  it('V03_ALL_ON_QUERY_FLAGS has enableMultiHopReasoning = true', () => {
    expect(V03_ALL_ON_QUERY_FLAGS.enableMultiHopReasoning).toBe(true);
  });
});
