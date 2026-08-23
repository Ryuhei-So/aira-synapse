import { describe, expect, it } from 'vitest';
import { baselineFor, compareRatchet, normalizeSummary } from '../../../scripts/coverage-ratchet.mjs';

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
