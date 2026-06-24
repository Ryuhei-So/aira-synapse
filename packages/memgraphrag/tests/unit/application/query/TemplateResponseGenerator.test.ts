import { describe, expect, it, vi } from 'vitest';
import type { ITermDictionary } from '../../../../src/domain/dictionary/index.js';
import type { ILLMProvider } from '../../../../src/domain/provider/index.js';
import type { IMemoryFilter, INodeInitializer } from '../../../../src/domain/retrieval/memoryFilter.js';
import type { IContextBuilder, IGraphProjection, IPPR } from '../../../../src/domain/retrieval/ppr.js';
import { DefaultQueryService } from '../../../../src/application/query/QueryService.js';
import { TemplateResponseGenerator } from '../../../../src/application/query/TemplateResponseGenerator.js';
import { createNotImplementedStub } from '../../../setup/testDoubles.js';

const contextBundle = {
  promptContext: 'Passage: Graph retrieval improves answers',
  citedPassages: [{
    passageId: 'passage-1',
    corpusId: 'corpus-1',
    text: 'Graph retrieval improves answers in academic corpora.',
    normalizedText: 'graph retrieval improves answers in academic corpora',
    metadata: { documentId: 'doc-1', title: 'Graph Retrieval', sourceUrl: 'https://example.com/doc-1', language: 'en', sectionPath: ['Intro'], chunkId: 'doc-1:0', chunkIndex: 0, offsetStart: 0, offsetEnd: 10 },
    factIds: ['fact-1'],
    entityMentions: ['Graph Retrieval'],
    qualityFlags: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }],
  citedFacts: [{
    factId: 'fact-1', corpusId: 'corpus-1', schemaId: 'schema-1', headEntity: 'Graph Retrieval', headType: 'Method', relation: 'improves', tailEntity: 'Answer Quality', tailType: 'Metric', state: 'active', passageIds: ['passage-1'], sourceDocumentIds: ['doc-1'], confidence: 0.9, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }],
  confidence: 0.9,
};

describe('TASK-MG-049: TemplateResponseGenerator', () => {
  it('generates citation-driven responses without an LLM', () => {
    const generator = new TemplateResponseGenerator();
    const response = generator.generate({ ...contextBundle, entities: ['Graph Retrieval', 'Answer Quality'] });

    expect(response).toContain('Based on 1 sources');
    expect(response).toContain('Graph Retrieval');
    expect(response).toContain('https://example.com/doc-1');
  });

  it('falls back to the template response when LLM generation is unavailable', async () => {
    const service = new DefaultQueryService({
      dictionary: { ...createNotImplementedStub<ITermDictionary>('ITermDictionary'), match: vi.fn().mockResolvedValue([]) },
      expansionPolicy: { expandQuery: vi.fn().mockResolvedValue({ originalQuery: 'graph retrieval', rewrittenQuery: 'graph retrieval', expandedTerms: [] }) },
      memoryFilter: { ...createNotImplementedStub<IMemoryFilter>('IMemoryFilter'), filter: vi.fn().mockResolvedValue({ ontology: [], facts: [], passages: [], expandedTerms: [], fallbackRequired: false, queryVector: [] }) },
      nodeInitializer: { ...createNotImplementedStub<INodeInitializer>('INodeInitializer'), initialize: vi.fn().mockResolvedValue({ scores: {}, fallbackTriggered: false }) },
      ppr: { ...createNotImplementedStub<IPPR>('IPPR'), run: vi.fn().mockResolvedValue({ rankedPassages: [], rankedEntities: [], iterations: 2, converged: true, l1Delta: 0 }) },
      projection: createNotImplementedStub<IGraphProjection>('IGraphProjection'),
      contextBuilder: { ...createNotImplementedStub<IContextBuilder>('IContextBuilder'), build: vi.fn().mockResolvedValue(contextBundle) },
      llm: { ...createNotImplementedStub<ILLMProvider>('ILLMProvider'), generate: vi.fn().mockRejectedValue(new Error('FEATURE_REQUIRES_API: llm unavailable')) },
      responseGenerator: new TemplateResponseGenerator(),
    });

    const result = await service.query({ corpusId: 'corpus-1', text: 'graph retrieval', topK: 5, topM: 3, threshold: 0.5, contextTokenLimit: 1000 });

    expect(result.response).toContain('Based on 1 sources');
    expect(result.metrics.fallbackTriggered).toBe(true);
    expect(result.metrics.llmInputTokens).toBe(0);
  });
});
