import { describe, expect, it, vi } from 'vitest';
import type { CorpusManager, DictionaryService, QueryService, ThesaurusService } from '../../../src/application/index.js';
import { handleBuildDictionaryFromApi, handleManageDictionary } from '../../../src/interface/mcp/handlers/dictionaryHandlers.js';
import { handleAnalyzeConflicts, handleExportGraph, handleGetStats, handleQuery } from '../../../src/interface/mcp/handlers/queryHandlers.js';
import { handleManageThesaurus } from '../../../src/interface/mcp/handlers/thesaurusHandlers.js';
import { toToolError } from '../../../src/interface/mcp/errors.js';
import { SERVICE_TOKENS, type MemGraphRagRuntime } from '../../../src/interface/runtime/MemGraphRagRuntime.js';
import { createPartialMock } from '../../setup/testDoubles.js';

function createRuntime(overrides: {
  corpusManager?: Partial<CorpusManager>;
  queryService?: Partial<QueryService>;
  dictionaryService?: Partial<DictionaryService & { buildFromApi(corpusId: string, domains: readonly string[], maxPapers: number): Promise<unknown> }>;
  thesaurusService?: Partial<ThesaurusService>;
} = {}): MemGraphRagRuntime {
  const corpusManager = createPartialMock<CorpusManager>('CorpusManager', {
    getStats: vi.fn().mockResolvedValue({
      memory: { totalSchemas: 1 },
      graph: { nodeCount: 2, edgeCount: 1, connectedComponents: 1 },
      dictionaries: { totalTerms: 3 },
      documents: [{ documentId: 'doc-1', title: 'Doc', indexedAt: '2026-01-01T00:00:00.000Z' }],
    }),
    analyzeConflicts: vi.fn().mockResolvedValue({ conflicts: [{ conflictId: 'c1', type: 'temporal', resolutionState: 'unresolved', confidence: 0.4 }], distribution: { unresolved: 1 } }),
    exportGraph: vi.fn().mockResolvedValue({ format: 'json', data: '{"nodes":[]}', offset: 0, limit: 100, hasMore: false, totalNodes: 0 }),
    ...overrides.corpusManager,
  });
  const queryService = createPartialMock<QueryService>('QueryService', {
    query: vi.fn().mockResolvedValue({
      response: 'answer',
      citations: [{ passageId: 'passage-1', title: 'Doc', sourceUrl: 'https://example.com', snippet: 'snippet' }],
      entities: [{ term: 'graph', matchedText: 'graph', boostFactor: 1.2 }],
      metrics: { dictionaryMatchCount: 1, expandedTerms: ['network'], fallbackTriggered: false, pprIterations: 2, pprConverged: true, citedPassageCount: 1, llmInputTokens: 10, llmOutputTokens: 5 },
    }),
    ...overrides.queryService,
  });
  const dictionaryService = createPartialMock<DictionaryService & { buildFromApi(corpusId: string, domains: readonly string[], maxPapers: number): Promise<unknown> }>('DictionaryService', {
    handle: vi.fn().mockResolvedValue({ action: 'stats', statistics: { totalTerms: 3 } }),
    buildFromApi: vi.fn().mockResolvedValue({ termCount: 12, domainDistribution: { biology: 12 } }),
    ...overrides.dictionaryService,
  });
  const thesaurusService = createPartialMock<ThesaurusService>('ThesaurusService', {
    handle: vi.fn().mockResolvedValue({ action: 'lookup', normalization: { canonicalTerm: 'cancer', originalTerm: 'carcinoma', appliedRelations: [] } }),
    ...overrides.thesaurusService,
  });

  return {
    start: async () => undefined,
    shutdown: async () => undefined,
    getService<T>(token: symbol): T {
      if (token === SERVICE_TOKENS.CORPUS_MANAGER) return corpusManager as T;
      if (token === SERVICE_TOKENS.QUERY_SERVICE) return queryService as T;
      if (token === SERVICE_TOKENS.DICTIONARY_SERVICE) return dictionaryService as T;
      if (token === SERVICE_TOKENS.THESAURUS_SERVICE) return thesaurusService as T;
      throw new Error(`Unexpected token ${String(token)}`);
    },
  };
}

describe('TASK-MG-038: query/lexicon MCP handlers', () => {
  it('queries a corpus', async () => {
    const result = await handleQuery({ corpus_id: 'corpus-1', query: 'graph', top_k: 5 }, createRuntime());
    expect(result.structuredContent).toEqual(expect.objectContaining({ response: 'answer' }));
  });

  it('validates query params', async () => {
    const error = await handleQuery({ corpus_id: 'corpus-1' }, createRuntime()).catch((value) => value);
    expect(error.code).toBe('INVALID_PARAMS');
  });

  it('gets stats', async () => {
    const result = await handleGetStats({ corpus_id: 'corpus-1' }, createRuntime());
    expect(result.structuredContent).toEqual(expect.objectContaining({ documents: [{ document_id: 'doc-1', title: 'Doc', indexed_at: '2026-01-01T00:00:00.000Z' }] }));
  });

  it('analyzes conflicts', async () => {
    const result = await handleAnalyzeConflicts({ corpus_id: 'corpus-1' }, createRuntime());
    expect(result.structuredContent).toEqual(expect.objectContaining({ distribution: { unresolved: 1 } }));
  });

  it('exports graph data', async () => {
    const result = await handleExportGraph({ corpus_id: 'corpus-1', format: 'json', limit: 100 }, createRuntime());
    expect(result.structuredContent).toEqual(expect.objectContaining({ format: 'json', total_nodes: 0 }));
  });

  it('dispatches manage_dictionary add payloads', async () => {
    const runtime = createRuntime({ dictionaryService: { handle: vi.fn().mockResolvedValue({ action: 'add', entries: [{ term: 'graph' }] }) } });
    const result = await handleManageDictionary({ corpus_id: 'corpus-1', action: 'add', entry: { term: 'Graph', domain: 'ml', confidence: 1, source: 'manual' } }, runtime);
    expect(result.structuredContent).toEqual({ action: 'add', result: [{ term: 'graph' }] });
  });

  it('dispatches manage_dictionary stats payloads', async () => {
    const result = await handleManageDictionary({ corpus_id: 'corpus-1', action: 'stats' }, createRuntime());
    expect(result.structuredContent).toEqual({ action: 'stats', result: { totalTerms: 3 } });
  });

  it('builds dictionary from api', async () => {
    const result = await handleBuildDictionaryFromApi({ corpus_id: 'corpus-1', domains: ['biology'], max_papers: 10 }, createRuntime());
    expect(result.structuredContent).toEqual({ term_count: 12, domain_distribution: { biology: 12 } });
  });

  it('dispatches manage_thesaurus lookup payloads', async () => {
    const result = await handleManageThesaurus({ corpus_id: 'corpus-1', action: 'lookup', term: 'carcinoma' }, createRuntime());
    expect(result.structuredContent).toEqual(expect.objectContaining({ action: 'lookup' }));
  });

  it('validates thesaurus params', async () => {
    const error = await handleManageThesaurus({ corpus_id: 'corpus-1', action: 'lookup' }, createRuntime()).catch((value) => value);
    expect(error.code).toBe('INVALID_PARAMS');
  });

  it('maps provider failures from dictionary api build', async () => {
    const runtime = createRuntime({ dictionaryService: { buildFromApi: vi.fn().mockRejectedValue(new Error('FEATURE_REQUIRES_API: missing integration')) } });
    const error = await handleBuildDictionaryFromApi({ corpus_id: 'corpus-1', domains: ['biology'], max_papers: 10 }, runtime).catch((value) => value);
    expect(toToolError(error).code).toBe('FEATURE_REQUIRES_API');
  });
});
