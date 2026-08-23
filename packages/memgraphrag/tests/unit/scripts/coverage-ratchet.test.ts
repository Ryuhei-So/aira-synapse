import { describe, expect, it } from 'vitest';
import { assertBaselineMatchesSummary, baselineFor, compareRatchet, normalizeSummary } from '../../../scripts/coverage-ratchet.mjs';

const files = {
  '/repo/src/a.ts': { lines: {}, statements: {}, functions: {}, branches: {} },
};
const summary = (covered = 8, total = 10, source = files) => ({
  ...source,
  total: Object.fromEntries(['lines', 'statements', 'functions', 'branches'].map((name) => [name, { covered, total }])),
});

describe('coverage ratchet', () => {
  it('accepts equal and improved metrics with the same source set', () => {
    const baseline = baselineFor(summary(), '/repo');
    expect(compareRatchet(normalizeSummary(summary(), '/repo'), baseline)).toBe(true);
    expect(compareRatchet(normalizeSummary(summary(9), '/repo'), baseline)).toBe(true);
  });
  it('requires the checked-in candidate baseline to exactly match its summary', () => {
    const candidate = normalizeSummary(summary(), '/repo');
    const baseline = baselineFor(summary(), '/repo');
    expect(() => assertBaselineMatchesSummary(candidate, baseline)).not.toThrow();
    baseline.metrics.lines.covered -= 1;
    expect(() => assertBaselineMatchesSummary(candidate, baseline)).toThrow(/exactly match/);
  });
  it('rejects a zero bootstrap floor as a false green', () => {
    const candidate = normalizeSummary(summary(1), '/repo');
    const bootstrap = { version: 1, targetPct: 80, sourceFileSetSha256: candidate.sourceFileSetSha256,
      metrics: { lines: { covered: 0, total: 10 }, statements: { covered: 0, total: 10 }, functions: { covered: 0, total: 10 }, branches: { covered: 0, total: 10 } } };
    expect(() => compareRatchet(candidate, bootstrap)).toThrow(/zero coverage baseline/);
  });
  it('rejects any metric regression using exact ratios', () => {
    const baseline = baselineFor(summary(), '/repo');
    expect(() => compareRatchet(normalizeSummary(summary(7), '/repo'), baseline)).toThrow(/regressed/);
  });
  it('rejects source file-set drift', () => {
    const baseline = baselineFor(summary(), '/repo');
    expect(() => compareRatchet(normalizeSummary(summary(8, 10, { ...files, '/repo/src/b.ts': files['/repo/src/a.ts'] }), '/repo'), baseline)).toThrow(/file set drifted/);
  });
  it('rejects malformed and missing summary totals', () => {
    expect(() => normalizeSummary({}, '/repo')).toThrow(/missing total/);
    expect(() => normalizeSummary({ total: {} }, '/repo')).toThrow(/invalid/);
  });
});
