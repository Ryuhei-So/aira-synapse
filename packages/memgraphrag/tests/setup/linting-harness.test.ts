import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// tests/setup/ → ../../ = packages/memgraphrag/
const PKG_ROOT = resolve(import.meta.dirname, '..', '..');

describe('TASK-MG-002: ESLint and test harness', () => {
  it('should have eslint.config.js', () => {
    expect(existsSync(resolve(PKG_ROOT, 'eslint.config.js'))).toBe(true);
  });

  it('should have vitest.setup.ts', () => {
    expect(
      existsSync(resolve(PKG_ROOT, 'tests/setup/vitest.setup.ts')),
    ).toBe(true);
  });

  it('should have testDoubles.ts', () => {
    expect(
      existsSync(resolve(PKG_ROOT, 'tests/setup/testDoubles.ts')),
    ).toBe(true);
  });

  it('should export createNotImplementedStub from testDoubles', async () => {
    const doubles = await import('./testDoubles.js');
    expect(typeof doubles.createNotImplementedStub).toBe('function');
  });

  it('should export createPartialMock from testDoubles', async () => {
    const doubles = await import('./testDoubles.js');
    expect(typeof doubles.createPartialMock).toBe('function');
  });

  it('should configure the coverage reporters without builtin thresholds', () => {
    const content = readFileSync(
      resolve(PKG_ROOT, 'vitest.config.ts'),
      'utf-8',
    );
    expect(content).toContain("reporter: ['text', 'json-summary']");
    expect(content).not.toContain('thresholds');
  });
});
