import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

// tests/unit/architecture/ → ../../../ = packages/memgraphrag/
const PKG_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const SRC = resolve(PKG_ROOT, 'src');

const LAYERS = ['domain', 'application', 'infrastructure', 'interface'] as const;

describe('TASK-MG-003: 4-layer directory and barrel exports', () => {
  describe('layer directories exist', () => {
    it.each(LAYERS)('should have src/%s/ directory', (layer) => {
      expect(existsSync(resolve(SRC, layer))).toBe(true);
    });

    it.each(LAYERS)('should have src/%s/index.ts barrel export', (layer) => {
      const indexPath = resolve(SRC, layer, 'index.ts');
      expect(existsSync(indexPath)).toBe(true);
      const content = readFileSync(indexPath, 'utf-8');
      expect(content.length).toBeGreaterThan(0);
    });
  });

  describe('test directories exist', () => {
    it.each(['unit', 'integration', 'contract', 'benchmark'])(
      'should have tests/%s/ directory',
      (dir) => {
        expect(existsSync(resolve(PKG_ROOT, 'tests', dir))).toBe(true);
      },
    );
  });

  describe('domain subdirectories', () => {
    it.each(['memory', 'agent', 'dictionary', 'retrieval', 'storage', 'provider'])(
      'should have src/domain/%s/',
      (sub) => {
        expect(existsSync(resolve(SRC, 'domain', sub))).toBe(true);
      },
    );
  });

  describe('layer boundary (no reverse dependencies)', () => {
    /**
     * Scans import statements in a layer's source files.
     * Domain must not import from application/infrastructure/interface.
     * Application must not import from infrastructure/interface.
     * Infrastructure must not import from application/interface.
     */
    function getImports(layerDir: string): string[] {
      if (!existsSync(layerDir)) return [];
      const files = getAllTsFiles(layerDir);
      const imports: string[] = [];
      for (const file of files) {
        const content = readFileSync(file, 'utf-8');
        const matches = content.matchAll(
          /(?:import|export)\s+.*?from\s+['"]([^'"]+)['"]/g,
        );
        for (const m of matches) {
          const specifier = m[1];
          if (specifier !== undefined) {
            imports.push(specifier);
          }
        }
      }
      return imports;
    }

    function getAllTsFiles(dir: string): string[] {
      const results: string[] = [];
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...getAllTsFiles(fullPath));
        } else if (entry.name.endsWith('.ts')) {
          results.push(fullPath);
        }
      }
      return results;
    }

    function importsForbiddenLayer(
      imports: string[],
      forbiddenLayers: string[],
    ): string[] {
      return imports.filter((imp) =>
        forbiddenLayers.some(
          (layer) =>
            imp.includes(`/${layer}/`) || imp.startsWith(`../${layer}`),
        ),
      );
    }

    it('domain should not import from application, infrastructure, or interface', () => {
      const imports = getImports(resolve(SRC, 'domain'));
      const violations = importsForbiddenLayer(imports, [
        'application',
        'infrastructure',
        'interface',
      ]);
      expect(violations).toEqual([]);
    });

    it('application should not import from infrastructure or interface', () => {
      const imports = getImports(resolve(SRC, 'application'));
      const violations = importsForbiddenLayer(imports, [
        'infrastructure',
        'interface',
      ]);
      expect(violations).toEqual([]);
    });

    it('infrastructure should not import from application or interface', () => {
      const imports = getImports(resolve(SRC, 'infrastructure'));
      const violations = importsForbiddenLayer(imports, [
        'application',
        'interface',
      ]);
      expect(violations).toEqual([]);
    });
  });
});
