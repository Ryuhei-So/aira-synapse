/**
 * Tests for storage factory (T-09 Runtime DI).
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  createLadybugAdapters,
  resolveBackend,
} from '../../../../src/infrastructure/storage/ladybug/storageFactory.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('storageFactory', () => {
  describe('resolveBackend', () => {
    const origEnv = process.env.MEMGRAPHRAG_BACKEND;
    afterEach(() => {
      if (origEnv === undefined) delete process.env.MEMGRAPHRAG_BACKEND;
      else process.env.MEMGRAPHRAG_BACKEND = origEnv;
    });

    it('defaults to sqlite', () => {
      delete process.env.MEMGRAPHRAG_BACKEND;
      expect(resolveBackend()).toBe('sqlite');
    });

    it('uses config value', () => {
      delete process.env.MEMGRAPHRAG_BACKEND;
      expect(resolveBackend('ladybug')).toBe('ladybug');
      expect(resolveBackend('aira-graphdb')).toBe('aira-graphdb');
    });

    it('env var overrides config', () => {
      process.env.MEMGRAPHRAG_BACKEND = 'ladybug';
      expect(resolveBackend('sqlite')).toBe('ladybug');
    });

    it('accepts aira-graphdb in env', () => {
      process.env.MEMGRAPHRAG_BACKEND = 'aira-graphdb';
      expect(resolveBackend('sqlite')).toBe('aira-graphdb');
    });

    it('rejects invalid backend', () => {
      expect(() => resolveBackend('postgres')).toThrow('Invalid storage backend');
    });
  });

  describe('createLadybugAdapters', () => {
    it('creates all LadybugDB adapters', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'factory-'));
      try {
        const adapters = await createLadybugAdapters({ dbPath: join(dir, 'test.lbug') });

        expect(adapters.graphStore).toBeDefined();
        expect(adapters.vectorIndex).toBeDefined();
        expect(adapters.memoryStore).toBeDefined();
        expect(adapters.graphProjection).toBeDefined();
        expect(adapters.lexicalRetriever).toBeDefined();
        expect(typeof adapters.close).toBe('function');

        await adapters.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('adapters are functional', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'factory-func-'));
      try {
        const adapters = await createLadybugAdapters({ dbPath: join(dir, 'test.lbug') });

        // Test graph store
        await adapters.graphStore.upsertNodes([{
          nodeId: 'n1', corpusId: 'c1', layer: 'fact', ref: {}, label: 'Test',
        }]);
        const node = await adapters.graphStore.getNode('c1', 'n1');
        expect(node?.nodeId).toBe('n1');

        // Test memory store
        await adapters.memoryStore.save({
          corpusId: 'c1', exportedAt: '', schemas: [], facts: [], passages: [], schemaVersion: 1,
        });
        const snap = await adapters.memoryStore.load('c1');
        expect(snap.corpusId).toBe('c1');

        await adapters.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
