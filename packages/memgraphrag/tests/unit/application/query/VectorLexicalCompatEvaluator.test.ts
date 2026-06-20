import { describe, expect, it } from 'vitest';

import {
  AgdbCompatValidationError,
  VectorLexicalCompatEvaluator,
} from '../../../../src/application/query/VectorLexicalCompatEvaluator.js';

describe('TASK-AGDB-038/039 VectorLexicalCompatEvaluator', () => {
  const evaluator = new VectorLexicalCompatEvaluator();

  it('computes vector topK set match rate', () => {
    const baseline = [
      { id: 'd1', score: 0.99 },
      { id: 'd2', score: 0.95 },
    ];
    const candidate = [
      { id: 'd2', score: 0.951 },
      { id: 'd1', score: 0.991 },
    ];
    const result = evaluator.compareVectorTopK(baseline, candidate, {
      scoreRoundingDecimals: 3,
    });
    expect(result.matchRate).toBe(1);
    expect([...result.matchedIds].sort()).toEqual(['d1', 'd2']);
  });

  it('applies threshold with epsilon during vector comparison', () => {
    const baseline = [
      { id: 'd1', score: 0.8 },
      { id: 'd2', score: 0.79 },
    ];
    const candidate = [
      { id: 'd1', score: 0.8 },
      { id: 'd2', score: 0.7899999 },
    ];
    const result = evaluator.compareVectorTopK(baseline, candidate, {
      threshold: 0.79,
      thresholdEpsilon: 0.0001,
    });
    expect(result.matchRate).toBe(1);
  });

  it('validates lexical schema and score/document sort', () => {
    expect(() => evaluator.assertLexicalSchemaAndSort([
      { documentId: 'doc-1', text: 'high score', score: 1, memoryType: 'passage' },
      { documentId: 'doc-2', text: 'low score', score: 0.5, memoryType: 'fact' },
    ])).not.toThrow();
  });

  it('throws INVALID_TOP_K for non-positive topK', () => {
    expect(() => evaluator.validateRequest({
      corpusId: 'c1',
      namespace: 'fact',
      topK: 0,
    })).toThrowError(AgdbCompatValidationError);
    try {
      evaluator.validateRequest({ corpusId: 'c1', namespace: 'fact', topK: 0 });
    } catch (error) {
      expect((error as AgdbCompatValidationError).code).toBe('INVALID_TOP_K');
    }
  });

  it('throws INVALID_THRESHOLD for out-of-range threshold', () => {
    expect(() => evaluator.validateRequest({
      corpusId: 'c1',
      namespace: 'fact',
      topK: 3,
      threshold: 2,
    })).toThrowError(AgdbCompatValidationError);
    try {
      evaluator.validateRequest({ corpusId: 'c1', namespace: 'fact', topK: 3, threshold: 2 });
    } catch (error) {
      expect((error as AgdbCompatValidationError).code).toBe('INVALID_THRESHOLD');
    }
  });

  it('throws INVALID_CORPUS_ID for empty corpusId', () => {
    expect(() => evaluator.validateRequest({
      corpusId: '',
      namespace: 'fact',
      topK: 3,
    })).toThrowError(AgdbCompatValidationError);
    try {
      evaluator.validateRequest({ corpusId: '', namespace: 'fact', topK: 3 });
    } catch (error) {
      expect((error as AgdbCompatValidationError).code).toBe('INVALID_CORPUS_ID');
    }
  });

  it('throws INVALID_NAMESPACE for empty namespace', () => {
    expect(() => evaluator.validateRequest({
      corpusId: 'c1',
      namespace: '',
      topK: 3,
    })).toThrowError(AgdbCompatValidationError);
    try {
      evaluator.validateRequest({ corpusId: 'c1', namespace: '', topK: 3 });
    } catch (error) {
      expect((error as AgdbCompatValidationError).code).toBe('INVALID_NAMESPACE');
    }
  });
});
