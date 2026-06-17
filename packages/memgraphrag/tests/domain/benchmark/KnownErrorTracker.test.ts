import { describe, it, expect } from 'vitest';
import {
  computeBenchmarkDelta,
  formatDeltaReport,
  type KnownErrorSet,
  type BenchmarkResult,
} from '../../../src/domain/benchmark/KnownErrorTracker.js';

describe('KnownErrorTracker', () => {
  const errorSet: KnownErrorSet = {
    version: 'v15-eval-v2',
    baselineAccuracy: '90.0%',
    baselineCorrect: 5,
    baselineErrors: 5,
    errors: [
      { questionId: 'e1', category: 'retrieval', goldAnswer: 'A', baselineResponse: 'B' },
      { questionId: 'e2', category: 'retrieval', goldAnswer: 'C', baselineResponse: 'D' },
      { questionId: 'e3', category: 'expression', goldAnswer: 'E', baselineResponse: 'F' },
      { questionId: 'e4', category: 'yesno', goldAnswer: 'yes', baselineResponse: 'no' },
      { questionId: 'e5', category: 'generic', goldAnswer: 'G', baselineResponse: 'H' },
    ],
    correctIds: ['c1', 'c2', 'c3', 'c4', 'c5'],
  };

  it('detects recovered errors by category', () => {
    const results = new Map<string, BenchmarkResult>([
      ['e1', { questionId: 'e1', correct: true, response: 'A' }],
      ['e2', { questionId: 'e2', correct: false, response: 'X' }],
      ['e3', { questionId: 'e3', correct: true, response: 'E' }],
      ['e4', { questionId: 'e4', correct: true, response: 'yes' }],
      ['e5', { questionId: 'e5', correct: false, response: 'Z' }],
      ['c1', { questionId: 'c1', correct: true, response: 'ok' }],
      ['c2', { questionId: 'c2', correct: true, response: 'ok' }],
      ['c3', { questionId: 'c3', correct: true, response: 'ok' }],
      ['c4', { questionId: 'c4', correct: true, response: 'ok' }],
      ['c5', { questionId: 'c5', correct: true, response: 'ok' }],
    ]);

    const delta = computeBenchmarkDelta(errorSet, results);

    expect(delta.recovered.retrieval).toEqual(['e1']);
    expect(delta.recovered.expression).toEqual(['e3']);
    expect(delta.recovered.yesno).toEqual(['e4']);
    expect(delta.recovered.generic).toEqual([]);
    expect(delta.summary.recoveredTotal).toBe(3);
    expect(delta.summary.regressedTotal).toBe(0);
    expect(delta.summary.netGain).toBe(3);
    expect(delta.unchanged).toEqual(['e2', 'e5']);
  });

  it('detects regressions from correct set', () => {
    const results = new Map<string, BenchmarkResult>([
      ['e1', { questionId: 'e1', correct: false, response: 'X' }],
      ['e2', { questionId: 'e2', correct: false, response: 'Y' }],
      ['e3', { questionId: 'e3', correct: false, response: 'Z' }],
      ['e4', { questionId: 'e4', correct: false, response: 'no' }],
      ['e5', { questionId: 'e5', correct: false, response: 'W' }],
      ['c1', { questionId: 'c1', correct: false, response: 'wrong' }],
      ['c2', { questionId: 'c2', correct: true, response: 'ok' }],
      ['c3', { questionId: 'c3', correct: false, response: 'wrong' }],
      ['c4', { questionId: 'c4', correct: true, response: 'ok' }],
      ['c5', { questionId: 'c5', correct: true, response: 'ok' }],
    ]);

    const delta = computeBenchmarkDelta(errorSet, results);

    expect(delta.summary.recoveredTotal).toBe(0);
    expect(delta.regressed).toEqual(['c1', 'c3']);
    expect(delta.summary.regressedTotal).toBe(2);
    expect(delta.summary.netGain).toBe(-2);
  });

  it('handles missing results gracefully', () => {
    const results = new Map<string, BenchmarkResult>();
    const delta = computeBenchmarkDelta(errorSet, results);

    expect(delta.summary.recoveredTotal).toBe(0);
    expect(delta.summary.regressedTotal).toBe(0);
    expect(delta.unchanged).toHaveLength(5);
  });

  it('formats delta report correctly', () => {
    const delta = {
      recovered: { retrieval: ['e1'], expression: ['e3'], yesno: ['e4'], generic: [], spelling: [] },
      regressed: ['c1'],
      unchanged: ['e2', 'e5'],
      summary: { recoveredTotal: 3, regressedTotal: 1, netGain: 2 },
    };

    const report = formatDeltaReport(delta);
    expect(report).toContain('Recovered: 3');
    expect(report).toContain('net gain: 2');
    expect(report).toContain('retrieval: +1');
    expect(report).toContain('Regressed: 1');
    expect(report).toContain('Unchanged errors: 2');
  });
});
