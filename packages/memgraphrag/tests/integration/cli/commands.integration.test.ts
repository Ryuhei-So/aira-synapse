import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCli } from '../../../src/interface/cli/index.js';
import { SERVICE_TOKENS, type MemGraphRagRuntime } from '../../../src/interface/runtime/MemGraphRagRuntime.js';

const root = resolve(process.cwd(), 'testing/cli-integration');

function createRuntime() {
  const calls = {
    index: vi.fn(async () => ({ jobId: 'job-1' })),
    query: vi.fn(async () => ({ response: 'ok', citations: [], entities: [], metrics: { dictionaryMatchCount: 0, expandedTerms: [], fallbackTriggered: false, pprIterations: 0, pprConverged: true, citedPassageCount: 0, llmInputTokens: 0, llmOutputTokens: 0 } })),
    stats: vi.fn(async () => ({ memory: { totalSchemas: 1 }, graph: { nodeCount: 2 }, dictionaries: { totalTerms: 1 }, documents: [] })),
    dictionary: vi.fn(async ({ action }: { action: string }) => ({ action, statistics: { totalTerms: 1 }, exportData: { corpusId: 'corpus-1' } })),
    dictionaryBuild: vi.fn(async () => ({ termCount: 2, domainDistribution: { ml: 2 } })),
    thesaurus: vi.fn(async ({ action }: { action: string }) => ({ action, normalization: { canonicalTerm: 'graph', originalTerm: 'graphs', appliedRelations: [] }, statistics: { totalRelations: 1 }, exportData: { corpusId: 'corpus-1' } })),
    visualize: vi.fn(async () => ({ format: 'json', data: '{"nodes":[]}', offset: 0, limit: 10000, hasMore: false, totalNodes: 0 })),
    conflicts: vi.fn(async () => ({ conflicts: [], distribution: { unresolved: 0 } })),
  };

  const runtime: MemGraphRagRuntime = {
    start: async () => undefined,
    shutdown: async () => undefined,
    getService<T>(token: symbol): T {
      if (token === SERVICE_TOKENS.INDEXING_SERVICE) return { start: calls.index, resume: vi.fn(), cancel: vi.fn(), deleteDocument: vi.fn() } as T;
      if (token === SERVICE_TOKENS.QUERY_SERVICE) return { query: calls.query } as T;
      if (token === SERVICE_TOKENS.CORPUS_MANAGER) return { getStats: calls.stats, exportGraph: calls.visualize, analyzeConflicts: calls.conflicts } as T;
      if (token === SERVICE_TOKENS.DICTIONARY_SERVICE) return { handle: calls.dictionary, buildFromApi: calls.dictionaryBuild } as T;
      if (token === SERVICE_TOKENS.THESAURUS_SERVICE) return { handle: calls.thesaurus } as T;
      throw new Error(`Unexpected token ${String(token)}`);
    },
  };

  return { runtime, calls };
}

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(resolve(root, 'doc.md'), '# Graph Retrieval\n\ncontent', 'utf8');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('TASK-MG-056: CLI command integration', () => {
  it('executes the index command end-to-end', async () => {
    const { runtime, calls } = createRuntime();
    const cli = createCli({ runtimeFactory: async () => runtime });
    await cli.parseAsync(['index', '--corpus-id', 'corpus-1', '--input', root, '--config', 'config.yml'], { from: 'user' });
    expect(calls.index).toHaveBeenCalledWith(expect.objectContaining({ corpusId: 'corpus-1' }));
  });

  it('executes the query command end-to-end', async () => {
    const { runtime, calls } = createRuntime();
    const cli = createCli({ runtimeFactory: async () => runtime });
    await cli.parseAsync(['query', '--corpus-id', 'corpus-1', '--query', 'graph'], { from: 'user' });
    expect(calls.query).toHaveBeenCalledWith(expect.objectContaining({ text: 'graph' }));
  });

  it('executes the stats command end-to-end', async () => {
    const { runtime, calls } = createRuntime();
    const cli = createCli({ runtimeFactory: async () => runtime });
    await cli.parseAsync(['stats', '--corpus-id', 'corpus-1'], { from: 'user' });
    expect(calls.stats).toHaveBeenCalledWith('corpus-1');
  });

  it('writes the default config through init', async () => {
    const cli = createCli();
    const output = resolve(root, 'memgraphrag.yml');
    await cli.parseAsync(['init', '--output', output], { from: 'user' });
    expect(existsSync(output)).toBe(true);
    expect(readFileSync(output, 'utf8').length).toBeGreaterThan(0);
  });

  it('executes the dictionary command end-to-end', async () => {
    const { runtime, calls } = createRuntime();
    const cli = createCli({ runtimeFactory: async () => runtime });
    await cli.parseAsync(['dictionary', 'build', '--corpus-id', 'corpus-1', '--domain', 'ml'], { from: 'user' });
    expect(calls.dictionaryBuild).toHaveBeenCalledWith('corpus-1', ['ml'], 100);
  });

  it('executes the thesaurus command end-to-end', async () => {
    const { runtime, calls } = createRuntime();
    const cli = createCli({ runtimeFactory: async () => runtime });
    await cli.parseAsync(['thesaurus', 'lookup', '--corpus-id', 'corpus-1', '--term', 'graphs'], { from: 'user' });
    expect(calls.thesaurus).toHaveBeenCalledWith(expect.objectContaining({ term: 'graphs' }));
  });

  it('executes the visualize command and writes output', async () => {
    const { runtime, calls } = createRuntime();
    const cli = createCli({ runtimeFactory: async () => runtime });
    const output = resolve(root, 'graph.json');
    await cli.parseAsync(['visualize', '--corpus-id', 'corpus-1', '--format', 'json', '--output', output], { from: 'user' });
    expect(calls.visualize).toHaveBeenCalledWith('corpus-1', 'json', 0, 10000);
    expect(readFileSync(output, 'utf8')).toContain('nodes');
  });

  it('executes the conflicts command end-to-end', async () => {
    const { runtime, calls } = createRuntime();
    const cli = createCli({ runtimeFactory: async () => runtime });
    await cli.parseAsync(['conflicts', '--corpus-id', 'corpus-1'], { from: 'user' });
    expect(calls.conflicts).toHaveBeenCalledWith('corpus-1');
  });
});
