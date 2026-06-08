import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import {
  validateMemGraphRagConfig,
  loadMemGraphRagConfig,
} from '../../../../src/infrastructure/config/index.js';

const CONFIG_DIR = resolve(import.meta.dirname, '..', '..', '..', '..', 'config');
const DEFAULT_CONFIG = resolve(CONFIG_DIR, 'default.memgraphrag.yml');

describe('TASK-MG-005: YAML config schema and validation', () => {
  describe('validateMemGraphRagConfig', () => {
    it('should accept a valid full config', () => {
      const valid = {
        version: 1,
        localOnly: false,
        dataDir: './data/memgraphrag',
        algorithms: {
          schema: { stabilizationThreshold: 2, canonicalizationThreshold: 0.9 },
          conflict: { similarityThreshold: 0.8, scanCandidateLimit: 100 },
          bridging: { similarityThreshold: 0.7, candidateLimit: 50 },
          retrieval: {
            topK: 10,
            topM: 5,
            threshold: 0.5,
            ppr: {
              teleportProbability: 0.5,
              passageDamping: 0.05,
              convergenceEpsilon: 1e-6,
              maxIterations: 50,
            },
          },
        },
        chunking: { chunkSizeTokens: 600, chunkOverlapTokens: 100, contextTokenLimit: 8000 },
        providers: {
          llm: { backend: 'openai', model: 'gpt-4o-mini', temperature: 0.1, maxTokens: 2048 },
          embedding: { backend: 'openai', model: 'text-embedding-3-large', cacheDir: './cache' },
          nlp: { backend: 'python-sidecar' as const, requestTimeoutMs: 30000, healthcheckTimeoutMs: 5000 },
        },
        storage: { sqlitePath: './db.sqlite', vectorIndexDir: './vectors', walMode: true, autoMigrate: true },
        security: { redactStackTraces: true, corpusIsolation: 'strict' as const },
        limits: { documentMaxBytes: 10485760, batchMaxDocuments: 100 },
        logging: { level: 'info' as const, auditLogPath: './audit.jsonl', structuredLogPath: './runtime.jsonl' },
      };
      const result = validateMemGraphRagConfig(valid);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject non-object input', () => {
      const result = validateMemGraphRagConfig('not an object');
      expect(result.valid).toBe(false);
      expect(result.errors[0]?.message).toContain('must be an object');
    });

    it('should reject null input', () => {
      const result = validateMemGraphRagConfig(null);
      expect(result.valid).toBe(false);
    });

    it('should report missing version', () => {
      const result = validateMemGraphRagConfig({ localOnly: false });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.path === '.version')).toBe(true);
    });

    it('should reject version < 1', () => {
      const config = makeMinimalConfig({ version: 0 });
      const result = validateMemGraphRagConfig(config);
      expect(result.errors.some((e) => e.path === '.version')).toBe(true);
    });

    it('should reject invalid NLP backend enum', () => {
      const config = makeMinimalConfig();
      (config.providers.nlp as Record<string, unknown>).backend = 'invalid';
      const result = validateMemGraphRagConfig(config);
      expect(result.errors.some((e) => e.path === 'providers.nlp.backend')).toBe(true);
    });

    it('should reject invalid logging level enum', () => {
      const config = makeMinimalConfig();
      (config.logging as Record<string, unknown>).level = 'verbose';
      const result = validateMemGraphRagConfig(config);
      expect(result.errors.some((e) => e.path === 'logging.level')).toBe(true);
    });

    it('should reject stabilizationThreshold < 1', () => {
      const config = makeMinimalConfig();
      (config.algorithms.schema as Record<string, unknown>).stabilizationThreshold = 0;
      const result = validateMemGraphRagConfig(config);
      expect(result.errors.some((e) => e.path === 'algorithms.schema.stabilizationThreshold')).toBe(true);
    });

    it('should reject similarity thresholds > 1', () => {
      const config = makeMinimalConfig();
      (config.algorithms.conflict as Record<string, unknown>).similarityThreshold = 1.5;
      const result = validateMemGraphRagConfig(config);
      expect(result.errors.some((e) => e.path === 'algorithms.conflict.similarityThreshold')).toBe(true);
    });

    it('should reject negative PPR teleport probability', () => {
      const config = makeMinimalConfig();
      (config.algorithms.retrieval.ppr as Record<string, unknown>).teleportProbability = -0.1;
      const result = validateMemGraphRagConfig(config);
      expect(result.errors.some((e) => e.path === 'algorithms.retrieval.ppr.teleportProbability')).toBe(true);
    });

    it('should reject temperature > 2', () => {
      const config = makeMinimalConfig();
      (config.providers.llm as Record<string, unknown>).temperature = 3;
      const result = validateMemGraphRagConfig(config);
      expect(result.errors.some((e) => e.path === 'providers.llm.temperature')).toBe(true);
    });

    it('should accept corpusIsolation: strict', () => {
      const config = makeMinimalConfig();
      const result = validateMemGraphRagConfig(config);
      expect(result.errors.filter((e) => e.path.includes('corpusIsolation'))).toHaveLength(0);
    });

    it('should reject invalid corpusIsolation value', () => {
      const config = makeMinimalConfig();
      (config.security as Record<string, unknown>).corpusIsolation = 'relaxed';
      const result = validateMemGraphRagConfig(config);
      expect(result.errors.some((e) => e.path === 'security.corpusIsolation')).toBe(true);
    });
  });

  describe('loadMemGraphRagConfig', () => {
    it('should load and validate default.memgraphrag.yml', () => {
      const config = loadMemGraphRagConfig(DEFAULT_CONFIG);
      expect(config.version).toBe(1);
      expect(config.localOnly).toBe(false);
      expect(config.algorithms.schema.stabilizationThreshold).toBe(2);
      expect(config.algorithms.retrieval.ppr.teleportProbability).toBe(0.5);
      expect(config.providers.nlp.backend).toBe('python-sidecar');
      expect(config.security.corpusIsolation).toBe('strict');
    });

    it('should throw on non-existent file', () => {
      expect(() => loadMemGraphRagConfig('/nonexistent.yml')).toThrow();
    });
  });

  describe('snake_case → camelCase transformation', () => {
    it('should transform YAML snake_case keys to camelCase', () => {
      const config = loadMemGraphRagConfig(DEFAULT_CONFIG);
      expect(config.dataDir).toBeDefined();
      expect(config.localOnly).toBeDefined();
      expect(config.algorithms.schema.stabilizationThreshold).toBeDefined();
    });
  });
});

/** Helper: creates a minimal valid config for mutation testing */
function makeMinimalConfig(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    localOnly: false,
    dataDir: './data',
    algorithms: {
      schema: { stabilizationThreshold: 2, canonicalizationThreshold: 0.9 },
      conflict: { similarityThreshold: 0.8, scanCandidateLimit: 100 },
      bridging: { similarityThreshold: 0.7, candidateLimit: 50 },
      retrieval: {
        topK: 10, topM: 5, threshold: 0.5,
        ppr: { teleportProbability: 0.5, passageDamping: 0.05, convergenceEpsilon: 1e-6, maxIterations: 50 },
      },
    },
    chunking: { chunkSizeTokens: 600, chunkOverlapTokens: 100, contextTokenLimit: 8000 },
    providers: {
      llm: { backend: 'openai', model: 'gpt-4o-mini', temperature: 0.1, maxTokens: 2048 },
      embedding: { backend: 'openai', model: 'text-embedding-3-large', cacheDir: './cache' },
      nlp: { backend: 'python-sidecar' as const, requestTimeoutMs: 30000, healthcheckTimeoutMs: 5000 },
    },
    storage: { sqlitePath: './db.sqlite', vectorIndexDir: './vectors', walMode: true, autoMigrate: true },
    security: { redactStackTraces: true, corpusIsolation: 'strict' as const },
    limits: { documentMaxBytes: 10485760, batchMaxDocuments: 100 },
    logging: { level: 'info' as const, auditLogPath: './audit.jsonl', structuredLogPath: './runtime.jsonl' },
    ...overrides,
  };
}
