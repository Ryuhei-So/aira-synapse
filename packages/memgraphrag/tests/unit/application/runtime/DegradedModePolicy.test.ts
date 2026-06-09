import { describe, expect, it } from 'vitest';
import type { MemGraphRagConfig } from '../../../../src/infrastructure/config/index.js';
import { DegradedModePolicy } from '../../../../src/application/runtime/DegradedModePolicy.js';

function createConfig(overrides: Partial<MemGraphRagConfig> = {}): MemGraphRagConfig {
  return {
    version: 1,
    localOnly: false,
    dataDir: 'testing/runtime-policy',
    algorithms: {
      schema: { stabilizationThreshold: 2, canonicalizationThreshold: 0.9 },
      conflict: { similarityThreshold: 0.8, scanCandidateLimit: 100 },
      bridging: { similarityThreshold: 0.7, candidateLimit: 50 },
      retrieval: { topK: 10, topM: 5, threshold: 0.5, ppr: { teleportProbability: 0.5, passageDamping: 0.05, convergenceEpsilon: 0.000001, maxIterations: 50 } },
    },
    chunking: { chunkSizeTokens: 500, chunkOverlapTokens: 100, contextTokenLimit: 8000 },
    providers: {
      llm: { backend: 'openai', model: 'gpt-test', temperature: 0.1, maxTokens: 256 },
      embedding: { backend: 'openai', model: 'embed-test', cacheDir: 'cache' },
      nlp: { backend: 'python-sidecar', pythonCommand: 'python3', requestTimeoutMs: 1000, healthcheckTimeoutMs: 1000 },
    },
    storage: { sqlitePath: 'mem.sqlite', vectorIndexDir: 'vectors', walMode: true, autoMigrate: true },
    security: { redactStackTraces: true, corpusIsolation: 'strict' },
    limits: { documentMaxBytes: 1024, batchMaxDocuments: 10 },
    logging: { level: 'info', auditLogPath: 'audit.jsonl', structuredLogPath: 'runtime.jsonl' },
    ...overrides,
  };
}

describe('TASK-MG-047: DegradedModePolicy', () => {
  it('prefers python sidecar and openai embeddings when healthy', () => {
    const policy = new DegradedModePolicy();
    const capabilities = policy.evaluateCapabilities(createConfig(), {
      pythonSidecar: { healthy: true },
      llm: { healthy: true },
      openaiEmbedding: { healthy: true },
    });

    expect(capabilities.selectedNlpExtractor).toBe('python-sidecar');
    expect(capabilities.selectedEmbeddingProvider).toBe('openai');
    expect(policy.getFeatureGates(capabilities).buildDictionaryFromApi).toBe(true);
  });

  it('falls back to regex and no embeddings in local-only mode', () => {
    const policy = new DegradedModePolicy();
    const capabilities = policy.evaluateCapabilities(createConfig({ localOnly: true }), {
      pythonSidecar: { healthy: false },
      llm: { healthy: false },
      openaiEmbedding: { healthy: false },
    });

    expect(capabilities.selectedNlpExtractor).toBe('regex');
    expect(capabilities.selectedEmbeddingProvider).toBe('none');
    expect(policy.getFeatureGates(capabilities).buildDictionaryFromApi).toBe(false);
    expect(policy.getFeatureGates(capabilities).templateResponse).toBe(true);
  });

  it('prefers local embeddings when openai is unavailable', () => {
    const policy = new DegradedModePolicy();
    const config = createConfig({
      providers: {
        llm: { backend: 'openai', model: 'gpt-test', temperature: 0.1, maxTokens: 256 },
        embedding: { backend: 'local', model: 'local-embed', cacheDir: 'cache' },
        nlp: { backend: 'python-sidecar', pythonCommand: 'python3', requestTimeoutMs: 1000, healthcheckTimeoutMs: 1000 },
      },
    });

    expect(policy.selectEmbeddingProvider(config, { localEmbedding: { healthy: true } })).toBe('local');
  });
});
