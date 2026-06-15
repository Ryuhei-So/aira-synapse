import { describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createCli } from '../../../src/interface/cli/index.js';
import { SERVICE_TOKENS, type MemGraphRagRuntime } from '../../../src/interface/runtime/MemGraphRagRuntime.js';

const artifactDir = resolve(process.cwd(), 'testing/cli-contract');

function createRuntime(): MemGraphRagRuntime {
  return {
    start: async () => undefined,
    shutdown: async () => undefined,
    getService<T>(token: symbol): T {
      if (token === SERVICE_TOKENS.INDEXING_SERVICE) {
        return {
          start: async () => ({ jobId: 'job-1' }),
          resume: async () => undefined,
          cancel: async () => undefined,
          deleteDocument: async () => ({ documentId: 'doc-1' }),
        } as T;
      }
      if (token === SERVICE_TOKENS.QUERY_SERVICE) {
        return {
          query: async () => ({ response: 'ok', citations: [], entities: [], metrics: { dictionaryMatchCount: 0, expandedTerms: [], fallbackTriggered: false, pprIterations: 0, pprConverged: true, citedPassageCount: 0, llmInputTokens: 0, llmOutputTokens: 0 } }),
        } as T;
      }
      if (token === SERVICE_TOKENS.CORPUS_MANAGER) {
        return {
          getStats: async () => ({ memory: {}, graph: {}, dictionaries: {}, documents: [] }),
          exportGraph: async () => ({ format: 'json', data: '{}', offset: 0, limit: 10000, hasMore: false, totalNodes: 0 }),
          analyzeConflicts: async () => ({ conflicts: [], distribution: {} }),
        } as T;
      }
      if (token === SERVICE_TOKENS.DICTIONARY_SERVICE) {
        return {
          handle: async ({ action }: { action: string }) => ({ action, statistics: {}, exportData: {} }),
          buildFromApi: async () => ({ termCount: 0, domainDistribution: {} }),
        } as T;
      }
      if (token === SERVICE_TOKENS.THESAURUS_SERVICE) {
        return {
          handle: async ({ action }: { action: string }) => ({ action, statistics: {}, exportData: {} }),
        } as T;
      }
      throw new Error(`Unexpected token ${String(token)}`);
    },
  };
}

const runtimeFactory = async () => createRuntime();

describe('TASK-MG-039: CLI command contract', () => {
  it('registers the expected top-level commands', () => {
    const cli = createCli({ runtimeFactory });
    const commandNames = cli.commands.map((command) => command.name());
    expect(commandNames).toEqual([
      'index',
      'query',
      'stats',
      'init',
      'dictionary',
      'lexicon',
      'thesaurus',
      'visualize',
      'conflicts',
    ]);
  });

  it('configures program metadata', () => {
    const cli = createCli({ runtimeFactory });
    expect(cli.name()).toBe('memgraphrag');
    expect(cli.description()).toBe('MemGraphRAG CLI');
  });

  it('parses index options', async () => {
    const cli = createCli({ runtimeFactory });
    await cli.parseAsync(['index', '--corpus-id', 'c1', '--input', '../../spec/REQ-MEMGRAPHRAG-001.md', '--config', 'config.yml'], { from: 'user' });
    const command = cli.commands.find((entry) => entry.name() === 'index');
    expect(command?.opts()).toEqual(expect.objectContaining({ corpusId: 'c1', input: '../../spec/REQ-MEMGRAPHRAG-001.md', config: 'config.yml' }));
  });

  it('parses query options', async () => {
    const cli = createCli({ runtimeFactory });
    await cli.parseAsync(['query', '--corpus-id', 'c1', '--query', 'hello', '--top-k', '3', '--top-m', '2', '--threshold', '0.7'], { from: 'user' });
    const command = cli.commands.find((entry) => entry.name() === 'query');
    expect(command?.opts()).toEqual(expect.objectContaining({ corpusId: 'c1', query: 'hello', topK: '3', topM: '2', threshold: '0.7' }));
  });

  it('parses stats options', async () => {
    const cli = createCli({ runtimeFactory });
    await cli.parseAsync(['stats', '--corpus-id', 'c1'], { from: 'user' });
    const command = cli.commands.find((entry) => entry.name() === 'stats');
    expect(command?.opts()).toEqual(expect.objectContaining({ corpusId: 'c1' }));
  });

  it('parses dictionary action and options', async () => {
    const cli = createCli({ runtimeFactory });
    await cli.parseAsync(['dictionary', 'build', '--corpus-id', 'c1', '--domain', 'biology'], { from: 'user' });
    const command = cli.commands.find((entry) => entry.name() === 'dictionary');
    expect(command?.args).toEqual(['build']);
    expect(command?.opts()).toEqual(expect.objectContaining({ corpusId: 'c1', domain: 'biology' }));
  });

  it('parses thesaurus action and options', async () => {
    const cli = createCli({ runtimeFactory });
    await cli.parseAsync(['thesaurus', 'lookup', '--corpus-id', 'c1', '--term', 'carcinoma'], { from: 'user' });
    const command = cli.commands.find((entry) => entry.name() === 'thesaurus');
    expect(command?.args).toEqual(['lookup']);
    expect(command?.opts()).toEqual(expect.objectContaining({ corpusId: 'c1', term: 'carcinoma' }));
  });

  it('parses visualize options', async () => {
    mkdirSync(artifactDir, { recursive: true });
    const output = resolve(artifactDir, 'graph.json');
    const cli = createCli({ runtimeFactory });
    await cli.parseAsync(['visualize', '--corpus-id', 'c1', '--format', 'json', '--output', output], { from: 'user' });
    const command = cli.commands.find((entry) => entry.name() === 'visualize');
    expect(command?.opts()).toEqual(expect.objectContaining({ corpusId: 'c1', format: 'json', output }));
    rmSync(artifactDir, { recursive: true, force: true });
  });

  it('parses conflicts options', async () => {
    const cli = createCli({ runtimeFactory });
    await cli.parseAsync(['conflicts', '--corpus-id', 'c1', '--json'], { from: 'user' });
    const command = cli.commands.find((entry) => entry.name() === 'conflicts');
    expect(command?.opts()).toEqual(expect.objectContaining({ corpusId: 'c1', json: true }));
  });

  it('renders help output with key commands', () => {
    const help = createCli({ runtimeFactory }).helpInformation();
    expect(help).toContain('Usage: memgraphrag');
    expect(help).toContain('index');
    expect(help).toContain('query');
    expect(help).toContain('dictionary');
    expect(help).toContain('thesaurus');
  });
});
