import { describe, expect, it, vi } from 'vitest';
import type { CorpusManager, DictionaryService, QueryService } from '../../../src/application/index.js';
import { handleBuildDictionaryFromApi, handleManageDictionary } from '../../../src/interface/mcp/handlers/dictionaryHandlers.js';
import { handleGetStats, handleQuery } from '../../../src/interface/mcp/handlers/queryHandlers.js';
import { SERVICE_TOKENS, type MemGraphRagRuntime } from '../../../src/interface/runtime/MemGraphRagRuntime.js';

function createRuntime() {
  const dictionaryEntries: Record<string, unknown>[] = [];
  const queryService: QueryService = {
    query: vi.fn(async () => ({
      response: 'Based on 1 sources: Graph retrieval improves answers.',
      citations: [{ passageId: 'passage-1', title: 'Graph Retrieval', sourceUrl: 'https://example.com/doc-1', snippet: 'Graph retrieval improves answers.' }],
      entities: [{ term: 'graph retrieval', matchedText: 'graph retrieval', boostFactor: 1.5 }],
      metrics: { dictionaryMatchCount: 1, expandedTerms: ['retrieval graph'], fallbackTriggered: true, pprIterations: 3, pprConverged: true, citedPassageCount: 1, llmInputTokens: 0, llmOutputTokens: 0 },
    })),
  };
  const dictionaryService: DictionaryService & { buildFromApi: DictionaryService['buildFromApi'] } = {
    handle: vi.fn(async (command) => {
      if (command.action === 'add' && command.entry) {
        dictionaryEntries.push(command.entry as unknown as Record<string, unknown>);
        return { action: 'add', entries: [command.entry] };
      }
      if (command.action === 'search') {
        return { action: 'search', entries: dictionaryEntries as never };
      }
      if (command.action === 'stats') {
        return { action: 'stats', statistics: { totalTerms: dictionaryEntries.length, domains: { ml: dictionaryEntries.length }, boostAppliedRate: 1, discoveredTermCount: dictionaryEntries.length } };
      }
      if (command.action === 'export') {
        return { action: 'export', exportData: { corpusId: command.corpusId, termDictionary: dictionaryEntries } };
      }
      if (command.action === 'import') {
        dictionaryEntries.push(...(command.data as unknown as Record<string, unknown>[] ?? []));
        return { action: 'import', entries: command.data };
      }
      return { action: command.action };
    }),
    buildFromApi: vi.fn(async () => ({ termCount: 4, domainDistribution: { ml: 4 } })),
  };
  const corpusManager: CorpusManager = {
    create: vi.fn(async () => ({ corpusId: 'corpus-1', name: 'Corpus', documentCount: 0, nodeCount: 0, createdAt: '2026-01-01T00:00:00.000Z' })),
    delete: vi.fn(async () => ({ corpusId: 'corpus-1', cancelledJobs: 0, deletedDocuments: 0, deletedNodes: 0, deletedEdges: 0, deletedVectorRecords: 0 })),
    list: vi.fn(async () => []),
    getStats: vi.fn(async () => ({ memory: { totalSchemas: 1 }, graph: { nodeCount: 2, edgeCount: 1, connectedComponents: 1 }, dictionaries: { totalTerms: dictionaryEntries.length }, documents: [{ documentId: 'doc-1', title: 'Graph Retrieval', indexedAt: '2026-01-01T00:00:00.000Z' }] })),
    getJobStatus: vi.fn(async () => ({ jobId: 'job-1', status: 'completed', processedCount: 1, totalCount: 1, errorCount: 0, errors: [] })),
    cancelJob: vi.fn(async () => ({ jobId: 'job-1', status: 'cancelled' })),
    analyzeConflicts: vi.fn(async () => ({ conflicts: [], distribution: {} })),
    exportGraph: vi.fn(async () => ({ format: 'json', data: '{}', offset: 0, limit: 100, hasMore: false, nextOffset: undefined, totalNodes: 0 })),
  };
  const runtime: MemGraphRagRuntime = {
    start: async () => undefined,
    shutdown: async () => undefined,
    getService<T>(token: symbol): T {
      if (token === SERVICE_TOKENS.QUERY_SERVICE) return queryService as T;
      if (token === SERVICE_TOKENS.DICTIONARY_SERVICE) return dictionaryService as T;
      if (token === SERVICE_TOKENS.CORPUS_MANAGER) return corpusManager as T;
      throw new Error(`Unexpected token ${String(token)}`);
    },
  };
  return { runtime, dictionaryEntries };
}

describe('TASK-MG-055: MCP query/lexicon integration', () => {
  it('returns citation-rich query results', async () => {
    const { runtime } = createRuntime();
    const result = await handleQuery({ corpus_id: 'corpus-1', query: 'graph retrieval' }, runtime);

    expect(result.structuredContent).toEqual(expect.objectContaining({ response: expect.stringContaining('Based on 1 sources') }));
    expect(result.structuredContent).toEqual(expect.objectContaining({ citations: [expect.objectContaining({ title: 'Graph Retrieval' })] }));
  });

  it('returns corpus stats alongside indexed documents', async () => {
    const { runtime } = createRuntime();
    const result = await handleGetStats({ corpus_id: 'corpus-1' }, runtime);

    expect(result.structuredContent).toEqual(expect.objectContaining({ documents: [expect.objectContaining({ title: 'Graph Retrieval' })] }));
  });

  it('adds and searches dictionary entries through MCP handlers', async () => {
    const { runtime } = createRuntime();
    await handleManageDictionary({ corpus_id: 'corpus-1', action: 'add', entry: { term: 'Graph Retrieval', domain: 'ml', confidence: 1, source: 'manual' } }, runtime);
    const result = await handleManageDictionary({ corpus_id: 'corpus-1', action: 'search', query: 'graph retrieval' }, runtime);

    expect(result.structuredContent).toEqual(expect.objectContaining({ action: 'search' }));
    expect((result.structuredContent as { result: unknown[] }).result).toHaveLength(1);
  });

  it('exports dictionary stats after mutations', async () => {
    const { runtime } = createRuntime();
    await handleManageDictionary({ corpus_id: 'corpus-1', action: 'add', entry: { term: 'Graph Retrieval', domain: 'ml', confidence: 1, source: 'manual' } }, runtime);
    const stats = await handleManageDictionary({ corpus_id: 'corpus-1', action: 'stats' }, runtime);
    const exported = await handleManageDictionary({ corpus_id: 'corpus-1', action: 'export' }, runtime);

    expect(stats.structuredContent).toEqual({ action: 'stats', result: expect.objectContaining({ totalTerms: 1 }) });
    expect(exported.structuredContent).toEqual(expect.objectContaining({ action: 'export' }));
  });

  it('builds dictionary entries from the scholarly API integration handler', async () => {
    const { runtime } = createRuntime();
    const result = await handleBuildDictionaryFromApi({ corpus_id: 'corpus-1', domains: ['ml'], max_papers: 5 }, runtime);

    expect(result.structuredContent).toEqual({ term_count: 4, domain_distribution: { ml: 4 } });
  });
});
