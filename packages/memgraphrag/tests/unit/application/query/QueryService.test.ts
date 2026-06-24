import { describe, it, expect, vi } from 'vitest';
import type { DictionaryMatch, ITermDictionary, IThesaurus } from '../../../../src/domain/dictionary/index.js';
import type { ILLMProvider } from '../../../../src/domain/provider/index.js';
import type { IMemoryFilter, INodeInitializer, QueryRequest } from '../../../../src/domain/retrieval/memoryFilter.js';
import type { IContextBuilder, IGraphProjection, IPPR, PPRResult } from '../../../../src/domain/retrieval/ppr.js';
import { createNotImplementedStub } from '../../../setup/testDoubles.js';
import { ContextBuilderService, DefaultQueryService } from '../../../../src/application/query/QueryService.js';
import { ThesaurusExpansionPolicy } from '../../../../src/application/query/ThesaurusExpansionPolicy.js';

const dictionaryEntry = {
  termId: 'term-1',
  term: 'GNN',
  canonicalForm: 'graph neural network',
  domainCategory: 'ml',
  aliases: [],
  frequency: 3,
  confidence: 0.9,
  source: 'manual' as const,
  version: '1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function createQueryRequest(): QueryRequest {
  return {
    corpusId: 'corpus-1',
    text: 'GNN for citation graphs',
    topK: 10,
    topM: 5,
    threshold: 0.5,
    contextTokenLimit: 2048,
  };
}

const ranking: PPRResult = {
  rankedPassages: [{ nodeId: 'passage:1', score: 0.8, layer: 'passage' }],
  rankedEntities: [{ nodeId: 'fact:1', score: 0.6, layer: 'fact' }],
  iterations: 6,
  converged: true,
  l1Delta: 0.000001,
};

describe('TASK-MG-034: DefaultQueryService', () => {
  it('runs the full query pipeline and returns metrics, citations, and matched entities', async () => {
    const dictionary = {
      ...createNotImplementedStub<ITermDictionary>('ITermDictionary'),
      match: vi.fn<ITermDictionary['match']>().mockResolvedValue([{ entry: dictionaryEntry, matchedText: 'GNN', boostFactor: 2 } satisfies DictionaryMatch]),
    } satisfies ITermDictionary;
    const thesaurus = {
      ...createNotImplementedStub<IThesaurus>('IThesaurus'),
      getRelations: vi.fn<IThesaurus['getRelations']>().mockResolvedValue([]),
    } satisfies IThesaurus;
    const expansionPolicy = new ThesaurusExpansionPolicy(thesaurus);
    const memoryFilter = {
      ...createNotImplementedStub<IMemoryFilter>('IMemoryFilter'),
      filter: vi.fn<IMemoryFilter['filter']>().mockResolvedValue({ ontology: [], facts: [], passages: [], expandedTerms: ['citation network'], fallbackRequired: false, queryVector: [] }),
    } satisfies IMemoryFilter;
    const nodeInitializer = {
      ...createNotImplementedStub<INodeInitializer>('INodeInitializer'),
      initialize: vi.fn<INodeInitializer['initialize']>().mockResolvedValue({ scores: { 'passage:1': 1 }, fallbackTriggered: false }),
    } satisfies INodeInitializer;
    const ppr = {
      ...createNotImplementedStub<IPPR>('IPPR'),
      run: vi.fn<IPPR['run']>().mockResolvedValue(ranking),
    } satisfies IPPR;
    const projection = createNotImplementedStub<IGraphProjection>('IGraphProjection');
    const contextBuilder = {
      ...createNotImplementedStub<IContextBuilder>('IContextBuilder'),
      build: vi.fn<IContextBuilder['build']>().mockResolvedValue({
        promptContext: 'Context passage',
        citedPassages: [{
          passageId: 'passage-1', corpusId: 'corpus-1', text: 'Context passage', normalizedText: 'context passage', metadata: { documentId: 'doc-1', title: 'Doc', sourceUrl: 'https://example.com', language: 'en', sectionPath: ['Intro'], chunkId: 'doc-1:0', chunkIndex: 0, offsetStart: 0, offsetEnd: 10 }, factIds: ['fact-1'], entityMentions: ['graph neural network'], qualityFlags: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        }],
        citedFacts: [{
          factId: 'fact-1', corpusId: 'corpus-1', schemaId: 'schema-1', headEntity: 'graph neural network', headType: 'Method', relation: 'improves', tailEntity: 'citation graphs', tailType: 'Task', state: 'active', passageIds: ['passage-1'], sourceDocumentIds: ['doc-1'], confidence: 0.9, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        }],
        confidence: 0.88,
      }),
    } satisfies IContextBuilder;
    const llm = {
      ...createNotImplementedStub<ILLMProvider>('ILLMProvider'),
      generate: vi.fn<ILLMProvider['generate']>().mockResolvedValue({ text: 'Use graph neural networks.', model: 'gpt-test', usage: { inputTokens: 10, outputTokens: 6 } }),
    } satisfies ILLMProvider;

    const service = new DefaultQueryService({ dictionary, expansionPolicy, memoryFilter, nodeInitializer, ppr, projection, contextBuilder, llm });
    const response = await service.query(createQueryRequest());

    expect(response.response).toContain('graph neural networks');
    expect(response.citations).toEqual([expect.objectContaining({ passageId: 'passage-1', title: 'Doc' })]);
    expect(response.entities).toEqual([expect.objectContaining({ term: 'graph neural network', matchedText: 'GNN' })]);
    expect(response.metrics.dictionaryMatchCount).toBe(1);
    expect(response.metrics.expandedTerms).toEqual(['citation network']);
  });

  it('normalizes query text before filtering and PPR initialization', async () => {
    const dictionary = {
      ...createNotImplementedStub<ITermDictionary>('ITermDictionary'),
      match: vi.fn<ITermDictionary['match']>().mockResolvedValue([]),
    } satisfies ITermDictionary;
    const service = new DefaultQueryService({
      dictionary,
      expansionPolicy: { expandQuery: vi.fn().mockResolvedValue({ originalQuery: 'GNN for citation graphs', expandedTerms: [], rewrittenQuery: 'GNN for citation graphs' }) },
      memoryFilter: { ...createNotImplementedStub<IMemoryFilter>('IMemoryFilter'), filter: vi.fn<IMemoryFilter['filter']>().mockResolvedValue({ ontology: [], facts: [], passages: [], expandedTerms: [], fallbackRequired: true, queryVector: [] }) },
      nodeInitializer: { ...createNotImplementedStub<INodeInitializer>('INodeInitializer'), initialize: vi.fn<INodeInitializer['initialize']>().mockResolvedValue({ scores: {}, fallbackTriggered: true }) },
      ppr: { ...createNotImplementedStub<IPPR>('IPPR'), run: vi.fn<IPPR['run']>().mockResolvedValue(ranking) },
      projection: createNotImplementedStub<IGraphProjection>('IGraphProjection'),
      contextBuilder: { ...createNotImplementedStub<IContextBuilder>('IContextBuilder'), build: vi.fn<IContextBuilder['build']>().mockResolvedValue({ promptContext: '', citedPassages: [], citedFacts: [], confidence: 0 }) },
      llm: { ...createNotImplementedStub<ILLMProvider>('ILLMProvider'), generate: vi.fn<ILLMProvider['generate']>().mockResolvedValue({ text: 'ok', model: 'test', usage: { inputTokens: 1, outputTokens: 1 } }) },
    });

    await service.query({ ...createQueryRequest(), text: '  GNN\nfor citation graphs  ' });
    expect(service['dependencies'].memoryFilter.filter).toHaveBeenCalledWith(expect.objectContaining({ text: 'GNN for citation graphs' }), undefined);
  });

  it('ContextBuilderService resolves ranked node ids into prompt context', async () => {
    const builder = new ContextBuilderService({
      getPassageByNodeId: async (nodeId) => nodeId === 'passage:1' ? {
        passageId: 'passage-1', corpusId: 'corpus-1', text: 'Important evidence', normalizedText: 'important evidence', metadata: { documentId: 'doc-1', title: 'Doc', sourceUrl: 'https://example.com', language: 'en', sectionPath: ['Intro'], chunkId: 'doc-1:0', chunkIndex: 0, offsetStart: 0, offsetEnd: 10 }, factIds: ['fact-1'], entityMentions: [], qualityFlags: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      } : null,
      getFactByNodeId: async (nodeId) => nodeId === 'fact:1' ? {
        factId: 'fact-1', corpusId: 'corpus-1', schemaId: 'schema-1', headEntity: 'GNN', headType: 'Method', relation: 'improves', tailEntity: 'retrieval', tailType: 'Task', state: 'active', passageIds: ['passage-1'], sourceDocumentIds: ['doc-1'], confidence: 0.9, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      } : null,
    });

    const bundle = await builder.build(createQueryRequest(), ranking);
    expect(bundle.promptContext).toContain('Important evidence');
    expect(bundle.promptContext).toContain('GNN improves retrieval');
  });

  it('reports fallback metrics when initializer triggers recovery mode', async () => {
    const service = new DefaultQueryService({
      dictionary: { ...createNotImplementedStub<ITermDictionary>('ITermDictionary'), match: vi.fn<ITermDictionary['match']>().mockResolvedValue([]) },
      expansionPolicy: { expandQuery: vi.fn().mockResolvedValue({ originalQuery: 'x', expandedTerms: [], rewrittenQuery: 'x' }) },
      memoryFilter: { ...createNotImplementedStub<IMemoryFilter>('IMemoryFilter'), filter: vi.fn<IMemoryFilter['filter']>().mockResolvedValue({ ontology: [], facts: [], passages: [], expandedTerms: [], fallbackRequired: true, queryVector: [] }) },
      nodeInitializer: { ...createNotImplementedStub<INodeInitializer>('INodeInitializer'), initialize: vi.fn<INodeInitializer['initialize']>().mockResolvedValue({ scores: {}, fallbackTriggered: true }) },
      ppr: { ...createNotImplementedStub<IPPR>('IPPR'), run: vi.fn<IPPR['run']>().mockResolvedValue({ ...ranking, converged: false }) },
      projection: createNotImplementedStub<IGraphProjection>('IGraphProjection'),
      contextBuilder: { ...createNotImplementedStub<IContextBuilder>('IContextBuilder'), build: vi.fn<IContextBuilder['build']>().mockResolvedValue({ promptContext: '', citedPassages: [], citedFacts: [], confidence: 0 }) },
      llm: { ...createNotImplementedStub<ILLMProvider>('ILLMProvider'), generate: vi.fn<ILLMProvider['generate']>().mockResolvedValue({ text: 'fallback', model: 'test', usage: { inputTokens: 1, outputTokens: 1 } }) },
    });

    const response = await service.query(createQueryRequest());
    expect(response.metrics.fallbackTriggered).toBe(true);
    expect(response.metrics.pprConverged).toBe(false);
  });
});
