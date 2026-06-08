import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PKG_ROOT = resolve(import.meta.dirname, '..', '..');
const readJson = (rel: string) =>
  JSON.parse(readFileSync(resolve(PKG_ROOT, rel), 'utf-8'));

describe('TASK-MG-001: Workspace and build foundation', () => {
  const pkg = readJson('package.json');

  describe('package.json', () => {
    it('should have type: module (ESM)', () => {
      expect(pkg.type).toBe('module');
    });

    it.each([
      'build',
      'test',
      'test:coverage',
      'lint',
      'bench',
      'start:mcp',
      'start:cli',
    ])('should have script "%s"', (script) => {
      expect(pkg.scripts).toHaveProperty(script);
      expect(pkg.scripts[script]).toBeTruthy();
    });

    it('should require Node >= 20', () => {
      expect(pkg.engines?.node).toMatch(/>=\s*20/);
    });

    it('should have ESM exports field', () => {
      expect(pkg.exports).toBeDefined();
      expect(pkg.exports['.']).toBeDefined();
      expect(pkg.exports['.'].import).toBeTruthy();
    });
  });

  describe('tsconfig.json', () => {
    const tsconfig = readJson('tsconfig.json');

    it('should target ES2022', () => {
      expect(tsconfig.compilerOptions.target).toBe('ES2022');
    });

    it('should use Node16 module resolution', () => {
      expect(tsconfig.compilerOptions.module).toBe('Node16');
      expect(tsconfig.compilerOptions.moduleResolution).toBe('Node16');
    });

    it('should enable strict mode', () => {
      expect(tsconfig.compilerOptions.strict).toBe(true);
    });

    it('should enable declaration generation', () => {
      expect(tsconfig.compilerOptions.declaration).toBe(true);
    });

    it('should enable verbatimModuleSyntax for ESM', () => {
      expect(tsconfig.compilerOptions.verbatimModuleSyntax).toBe(true);
    });
  });

  describe('tsconfig.build.json', () => {
    const tsBuild = readJson('tsconfig.build.json');

    it('should extend tsconfig.json', () => {
      expect(tsBuild.extends).toBe('./tsconfig.json');
    });

    it('should enable incremental builds', () => {
      expect(tsBuild.compilerOptions.incremental).toBe(true);
    });
  });

  describe('vitest.config.ts', () => {
    it('should exist and be importable', async () => {
      const config = await import('../../vitest.config.js');
      expect(config.default).toBeDefined();
    });
  });

  describe('src/index.ts', () => {
    it('should exist as module entry point', () => {
      const content = readFileSync(
        resolve(PKG_ROOT, 'src/index.ts'),
        'utf-8',
      );
      expect(content).toBeTruthy();
    });
  });
});
