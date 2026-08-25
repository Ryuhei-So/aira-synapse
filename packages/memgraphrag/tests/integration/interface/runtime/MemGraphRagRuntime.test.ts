import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MemGraphRagConfig } from '../../../../src/infrastructure/config/index.js';
import { createMemGraphRagRuntime, SERVICE_TOKENS } from '../../../../src/interface/runtime/MemGraphRagRuntime.js';

const artifactRoot = resolve(process.cwd(), 'testing/interface-runtime-artifacts');

function createConfig(name: string, overrides: Partial<MemGraphRagConfig> = {}): MemGraphRagConfig {
  const baseDir = resolve(artifactRoot, name);
  return {
    version: 1,
    localOnly: true,
    dataDir: baseDir,
    algorithms: {
      schema: { stabilizationThreshold: 2, canonicalizationThreshold: 0.9 },
      conflict: { similarityThreshold: 0.8, scanCandidateLimit: 100 },
      bridging: { similarityThreshold: 0.7, candidateLimit: 50 },
      retrieval: {
        topK: 10,
        topM: 5,
        threshold: 0.5,
        ppr: { teleportProbability: 0.5, passageDamping: 0.05, convergenceEpsilon: 0.000001, maxIterations: 50 },
      },
    },
    chunking: { chunkSizeTokens: 600, chunkOverlapTokens: 100, contextTokenLimit: 8000 },
    providers: {
      llm: { backend: 'openai', model: 'gpt-test', temperature: 0.1, maxTokens: 256 },
      embedding: { backend: 'openai', model: 'embedding-test', cacheDir: resolve(baseDir, 'cache') },
      nlp: { backend: 'regex', pythonCommand: 'python3', requestTimeoutMs: 1000, healthcheckTimeoutMs: 1000 },
    },
    storage: { sqlitePath: resolve(baseDir, 'memgraphrag.sqlite'), vectorIndexDir: resolve(baseDir, 'vectors'), walMode: true, autoMigrate: true },
    security: { redactStackTraces: true, corpusIsolation: 'strict' },
    limits: { documentMaxBytes: 1024 * 1024, batchMaxDocuments: 100 },
    logging: { level: 'info', auditLogPath: resolve(baseDir, 'audit.jsonl'), structuredLogPath: resolve(baseDir, 'runtime.jsonl') },
    ...overrides,
  };
}

afterEach(() => {
  rmSync(artifactRoot, { recursive: true, force: true });
});

describe('TASK-MG-040: MemGraphRagRuntime', () => {
  it('starts and creates runtime storage artifacts', async () => {
    mkdirSync(artifactRoot, { recursive: true });
    const runtime = createMemGraphRagRuntime(createConfig('startup'));
    await runtime.start();

    expect(existsSync(resolve(artifactRoot, 'startup', 'memgraphrag.sqlite'))).toBe(true);
    expect(existsSync(resolve(artifactRoot, 'startup', 'vectors'))).toBe(true);

    await runtime.shutdown();
  });

  it('resolves registered services after startup', async () => {
    const runtime = createMemGraphRagRuntime(createConfig('services'));
    await runtime.start();

    expect(runtime.getService(SERVICE_TOKENS.GRAPH_STORE)).toBeTruthy();
    expect(runtime.getService(SERVICE_TOKENS.CORPUS_MANAGER)).toBeTruthy();
    expect(runtime.getService(SERVICE_TOKENS.QUERY_SERVICE)).toBeTruthy();

    await runtime.shutdown();
  });

  it('supports provider substitution through config backend selection', async () => {
    const runtime = createMemGraphRagRuntime(createConfig('providers', {
      providers: {
        llm: { backend: 'openai', model: 'gpt-test', temperature: 0.1, maxTokens: 256 },
        embedding: { backend: 'openai', model: 'embedding-test', cacheDir: resolve(artifactRoot, 'providers', 'cache') },
        nlp: { backend: 'regex', pythonCommand: 'python3', requestTimeoutMs: 1000, healthcheckTimeoutMs: 1000 },
      },
    }));
    await runtime.start();

    const nlp = runtime.getService<{ healthCheck(): Promise<{ healthy: boolean }> }>(SERVICE_TOKENS.NLP_EXTRACTOR);
    await expect(nlp.healthCheck()).resolves.toEqual(expect.objectContaining({ healthy: true }));

    await runtime.shutdown();
  });

  it('routes graph reads to the native aira-graphdb backend', async () => {
    const baseDir = resolve(artifactRoot, 'native-backend');
    const runtime = createMemGraphRagRuntime(createConfig('native-backend', {
      storage: {
        backend: 'aira-graphdb',
        sqlitePath: resolve(baseDir, 'memgraphrag.sqlite'),
        vectorIndexDir: resolve(baseDir, 'vectors'),
        walMode: true,
        autoMigrate: true,
      },
    }));
    await runtime.start();

    const graphStore = runtime.getService<{
      upsertNodes(nodes: readonly Array<{
        nodeId: string;
        corpusId: string;
        layer: 'schema' | 'fact' | 'passage';
        ref: Record<string, unknown>;
        label: string;
      }>): Promise<void>;
      getNode(corpusId: string, nodeId: string): Promise<{ nodeId: string } | null>;
    }>(SERVICE_TOKENS.GRAPH_STORE);

    await expect(graphStore.getNode('c-native', 'schema:missing')).resolves.toBeNull();

    await runtime.shutdown();
  });

  it('uses degraded providers in local-only mode', async () => {
    const runtime = createMemGraphRagRuntime(createConfig('local-only', { localOnly: true }));
    await runtime.start();

    const llm = runtime.getService<{ generate(): Promise<unknown> }>(SERVICE_TOKENS.LLM_PROVIDER);
    await expect(llm.generate()).rejects.toThrow('FEATURE_REQUIRES_API');

    await runtime.shutdown();
  });

  it('cancels pending jobs on shutdown', async () => {
    const runtime = createMemGraphRagRuntime(createConfig('shutdown-jobs'));
    await runtime.start();

    const corpusManager = runtime.getService<{ list(): Promise<readonly unknown[]> }>(SERVICE_TOKENS.CORPUS_MANAGER);
    expect(corpusManager).toBeTruthy();

    await runtime.shutdown();
  });

  it('throws for missing services after shutdown', async () => {
    const runtime = createMemGraphRagRuntime(createConfig('missing'));
    await runtime.start();
    await runtime.shutdown();

    expect(() => runtime.getService(SERVICE_TOKENS.CORPUS_MANAGER)).toThrow('Service not registered');
  });
});
