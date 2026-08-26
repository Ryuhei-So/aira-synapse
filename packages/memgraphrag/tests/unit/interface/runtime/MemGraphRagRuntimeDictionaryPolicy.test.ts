import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemGraphRagConfig } from '../../../../src/infrastructure/config/index.js';

// Temporary CI synchronization marker; removed before the qualifying run.
const state = vi.hoisted(() => ({
  adapterClose: vi.fn().mockResolvedValue(undefined),
  createAiraGraphDbAdapters: vi.fn(),
  pipelineOptions: [] as Array<Record<PropertyKey, unknown>>,
  resolveBackendCalls: [] as Array<string | undefined>,
}));

vi.mock('../../../../src/application/indexing/FullDocumentIndexingPipeline.js', () => ({
  FullDocumentIndexingPipeline: class {
    public constructor(options: Record<PropertyKey, unknown>) {
      state.pipelineOptions.push(options);
    }

    public readonly processDocument = vi.fn();
  },
}));

vi.mock('../../../../src/infrastructure/storage/ladybug/storageFactory.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const resolveBackend = actual.resolveBackend as (configBackend?: string) => string;
  return {
    ...actual,
    createAiraGraphDbAdapters: state.createAiraGraphDbAdapters,
    resolveBackend: (configBackend?: string) => {
      state.resolveBackendCalls.push(configBackend);
      return resolveBackend(configBackend);
    },
  };
});

import {
  createMemGraphRagRuntime,
  SERVICE_TOKENS,
  type MemGraphRagRuntime,
} from '../../../../src/interface/runtime/MemGraphRagRuntime.js';

const artifactRoot = resolve(process.cwd(), 'testing/graphdb-dictionary-disabled-runtime');
const originalBackend = process.env['MEMGRAPHRAG_BACKEND'];
let activeRuntime: MemGraphRagRuntime | undefined;

function createConfig(
  name: string,
  backend: 'aira-graphdb' | 'sqlite' | 'ladybug' | 'neo4j',
  localOnly = false,
): MemGraphRagConfig {
  const baseDir = resolve(artifactRoot, name);
  return {
    version: 1,
    localOnly,
    dataDir: baseDir,
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
          convergenceEpsilon: 0.000001,
          maxIterations: 50,
        },
      },
    },
    chunking: { chunkSizeTokens: 600, chunkOverlapTokens: 100, contextTokenLimit: 8000 },
    providers: {
      llm: { backend: 'openai', model: 'gpt-test', temperature: 0.1, maxTokens: 256 },
      embedding: { backend: 'openai', model: 'embedding-test', cacheDir: resolve(baseDir, 'cache') },
      nlp: {
        backend: 'regex',
        pythonCommand: 'python3',
        requestTimeoutMs: 1000,
        healthcheckTimeoutMs: 1000,
      },
    },
    storage: {
      backend,
      sqlitePath: resolve(baseDir, 'memgraphrag.sqlite'),
      vectorIndexDir: resolve(baseDir, 'vectors'),
      walMode: true,
      autoMigrate: true,
    },
    security: { redactStackTraces: true, corpusIsolation: 'strict' },
    limits: { documentMaxBytes: 1024 * 1024, batchMaxDocuments: 100 },
    logging: {
      level: 'info',
      auditLogPath: resolve(baseDir, 'audit.jsonl'),
      structuredLogPath: resolve(baseDir, 'runtime.jsonl'),
    },
  };
}

beforeEach(() => {
  delete process.env['MEMGRAPHRAG_BACKEND'];
  mkdirSync(artifactRoot, { recursive: true });
  state.pipelineOptions.length = 0;
  state.resolveBackendCalls.length = 0;
  activeRuntime = undefined;
  state.adapterClose.mockReset().mockResolvedValue(undefined);
  state.createAiraGraphDbAdapters.mockReset().mockResolvedValue({
    graphStore: {},
    vectorIndex: {},
    memoryStore: {},
    indexingMemory: {},
    graphProjection: {},
    lexicalRetriever: {},
    close: state.adapterClose,
  });
});

afterEach(async () => {
  await activeRuntime?.shutdown();
  activeRuntime = undefined;
  if (originalBackend === undefined) {
    delete process.env['MEMGRAPHRAG_BACKEND'];
  } else {
    process.env['MEMGRAPHRAG_BACKEND'] = originalBackend;
  }
  rmSync(artifactRoot, { recursive: true, force: true });
});

describe.sequential('Issue #15 GraphDB Runtime dictionary policy', () => {
  it('constructs the production GraphDB pipeline with Stage V disabled and no dictionary inputs', async () => {
    const runtime = activeRuntime = createMemGraphRagRuntime(createConfig('graphdb', 'aira-graphdb'));
    await runtime.start();

    expect(state.createAiraGraphDbAdapters).toHaveBeenCalledOnce();
    expect(state.resolveBackendCalls).toEqual(['aira-graphdb']);
    expect(state.pipelineOptions).toHaveLength(1);
    const options = state.pipelineOptions[0]!;
    expect(Reflect.ownKeys(options)).toEqual([
      'db',
      'graphStore',
      'vectorIndex',
      'indexingMemory',
      'llmProvider',
      'embeddingProvider',
      'nlpExtractor',
      'enableDictionaryIndexing',
    ]);
    expect(options.enableDictionaryIndexing).toBe(false);
    expect(Object.getOwnPropertyDescriptor(options, 'dictionary')).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(options, 'dictionaryFactory')).toBeUndefined();

    const dictionary = runtime.getService(SERVICE_TOKENS.TERM_DICTIONARY);
    expect(dictionary).toBeTruthy();
    expect(runtime.getService(SERVICE_TOKENS.THESAURUS)).toBe(dictionary);

    await runtime.shutdown();
    expect(state.adapterClose).toHaveBeenCalledOnce();
  });

  it.each(['sqlite', 'ladybug', 'neo4j'] as const)(
    'preserves the existing %s FullPipeline dictionary options exactly',
    async (backend) => {
      const runtime = activeRuntime = createMemGraphRagRuntime(createConfig(backend, backend));
      await runtime.start();

      expect(state.createAiraGraphDbAdapters).not.toHaveBeenCalled();
      expect(state.resolveBackendCalls).toEqual([backend]);
      expect(state.pipelineOptions).toHaveLength(1);
      const options = state.pipelineOptions[0]!;
      expect(Reflect.ownKeys(options)).toEqual([
        'db',
        'graphStore',
        'vectorIndex',
        'indexingMemory',
        'llmProvider',
        'embeddingProvider',
        'nlpExtractor',
        'enableDictionaryIndexing',
        'dictionary',
        'dictionaryFactory',
      ]);
      expect(options.enableDictionaryIndexing).toBe(true);
      expect(options.dictionary).toBe(runtime.getService(SERVICE_TOKENS.TERM_DICTIONARY));
      expect(typeof options.dictionaryFactory).toBe('function');
      const factory = options.dictionaryFactory as (corpusId: string) => unknown;
      expect(factory('c1')).not.toBe(factory('c1'));

      await runtime.shutdown();
    },
  );

  it('keeps local-only GraphDB on the Minimal pipeline while retaining public dictionary services', async () => {
    const runtime = activeRuntime = createMemGraphRagRuntime(
      createConfig('local-only', 'aira-graphdb', true),
    );
    await runtime.start();

    expect(state.createAiraGraphDbAdapters).toHaveBeenCalledOnce();
    expect(state.resolveBackendCalls).toEqual(['aira-graphdb']);
    expect(state.pipelineOptions).toEqual([]);
    const dictionary = runtime.getService(SERVICE_TOKENS.TERM_DICTIONARY);
    expect(dictionary).toBeTruthy();
    expect(runtime.getService(SERVICE_TOKENS.THESAURUS)).toBe(dictionary);

    await runtime.shutdown();
  });

  it('uses one environment-selected GraphDB classification and never builds fallback options', async () => {
    process.env['MEMGRAPHRAG_BACKEND'] = 'aira-graphdb';
    const runtime = activeRuntime = createMemGraphRagRuntime(createConfig('env-graphdb', 'sqlite'));
    await runtime.start();

    expect(state.resolveBackendCalls).toEqual(['sqlite']);
    expect(state.createAiraGraphDbAdapters).toHaveBeenCalledOnce();
    expect(state.pipelineOptions).toHaveLength(1);
    expect(Reflect.ownKeys(state.pipelineOptions[0]!)).toEqual([
      'db',
      'graphStore',
      'vectorIndex',
      'indexingMemory',
      'llmProvider',
      'embeddingProvider',
      'nlpExtractor',
      'enableDictionaryIndexing',
    ]);
    expect(state.pipelineOptions[0]!.enableDictionaryIndexing).toBe(false);

    await runtime.shutdown();
  });

  it('keeps invalid backend selection as a pre-construction Promise rejection', async () => {
    process.env['MEMGRAPHRAG_BACKEND'] = 'invalid-backend';
    const runtime = activeRuntime = createMemGraphRagRuntime(createConfig('invalid', 'sqlite'));

    await expect(runtime.start()).rejects.toThrow('Invalid storage backend');
    expect(state.resolveBackendCalls).toEqual(['sqlite']);
    expect(state.createAiraGraphDbAdapters).not.toHaveBeenCalled();
    expect(state.pipelineOptions).toEqual([]);
  });
});
