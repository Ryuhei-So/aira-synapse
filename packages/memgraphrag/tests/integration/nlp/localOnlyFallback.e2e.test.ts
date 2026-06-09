import { describe, expect, it, vi } from 'vitest';
import { RegexExtractor } from '../../../src/infrastructure/nlp/RegexExtractor.js';
import { DegradedModePolicy } from '../../../src/application/runtime/DegradedModePolicy.js';
import { Bm25LexicalRetriever } from '../../../src/infrastructure/retrieval/Bm25LexicalRetriever.js';
import { DefaultQueryService } from '../../../src/application/query/QueryService.js';
import { TemplateResponseGenerator } from '../../../src/application/query/TemplateResponseGenerator.js';
import { createNotImplementedStub } from '../../setup/testDoubles.js';
import type { ITermDictionary } from '../../../src/domain/dictionary/index.js';
import type { ILLMProvider } from '../../../src/domain/provider/index.js';
import type { IMemoryFilter, INodeInitializer } from '../../../src/domain/retrieval/memoryFilter.js';
import type { IContextBuilder, IGraphProjection, IPPR } from '../../../src/domain/retrieval/ppr.js';

describe('TASK-MG-058: local-only fallback e2e', () => {
  it('uses RegexExtractor when the sidecar is unavailable', async () => {
    const policy = new DegradedModePolicy();
    const extractor = policy.selectNlpExtractor({ localOnly: true, providers: { llm: { backend: 'openai' }, embedding: { backend: 'openai' }, nlp: { backend: 'python-sidecar' } } }, { pythonSidecar: { healthy: false }, llm: { healthy: false } });
    const result = await new RegexExtractor().extract({ text: 'Graph Retrieval uses BM25 in Tokyo.', language: 'en' });

    expect(extractor).toBe('regex');
    expect(result.entities.map((entity) => entity.text)).toContain('Graph Retrieval');
  });

  it('uses BM25 lexical fallback when embeddings are unavailable', async () => {
    const retriever = new Bm25LexicalRetriever();
    await retriever.indexPassages('corpus-1', [{
      passageId: 'passage-1', corpusId: 'corpus-1', text: 'Graph retrieval improves answers', normalizedText: 'graph retrieval improves answers', metadata: { documentId: 'doc-1', title: 'Doc 1', sourceUrl: 'https://example.com/doc-1', language: 'en', sectionPath: ['Intro'], chunkId: 'doc-1:0', chunkIndex: 0, offsetStart: 0, offsetEnd: 10 }, factIds: [], entityMentions: ['Graph Retrieval'], qualityFlags: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }]);

    const results = await retriever.search('corpus-1', 'graph retrieval', 5);
    expect(results[0]?.passageId).toBe('passage-1');
  });

  it('uses template responses when the LLM is unavailable', async () => {
    const service = new DefaultQueryService({
      dictionary: { ...createNotImplementedStub<ITermDictionary>('ITermDictionary'), match: vi.fn().mockResolvedValue([]) },
      expansionPolicy: { expandQuery: vi.fn().mockResolvedValue({ originalQuery: 'graph retrieval', rewrittenQuery: 'graph retrieval', expandedTerms: [] }) },
      memoryFilter: { ...createNotImplementedStub<IMemoryFilter>('IMemoryFilter'), filter: vi.fn().mockResolvedValue({ ontology: [], facts: [], passages: [], expandedTerms: [], fallbackRequired: true }) },
      nodeInitializer: { ...createNotImplementedStub<INodeInitializer>('INodeInitializer'), initialize: vi.fn().mockResolvedValue({ scores: {}, fallbackTriggered: true }) },
      ppr: { ...createNotImplementedStub<IPPR>('IPPR'), run: vi.fn().mockResolvedValue({ rankedPassages: [], rankedEntities: [], iterations: 1, converged: true, l1Delta: 0 }) },
      projection: createNotImplementedStub<IGraphProjection>('IGraphProjection'),
      contextBuilder: { ...createNotImplementedStub<IContextBuilder>('IContextBuilder'), build: vi.fn().mockResolvedValue({ promptContext: 'Passage: Graph retrieval improves answers', citedPassages: [{ passageId: 'passage-1', corpusId: 'corpus-1', text: 'Graph retrieval improves answers', normalizedText: 'graph retrieval improves answers', metadata: { documentId: 'doc-1', title: 'Doc 1', sourceUrl: 'https://example.com/doc-1', language: 'en', sectionPath: ['Intro'], chunkId: 'doc-1:0', chunkIndex: 0, offsetStart: 0, offsetEnd: 10 }, factIds: [], entityMentions: ['Graph Retrieval'], qualityFlags: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }], citedFacts: [], confidence: 0.9 }) },
      llm: { ...createNotImplementedStub<ILLMProvider>('ILLMProvider'), generate: vi.fn().mockRejectedValue(new Error('FEATURE_REQUIRES_API: llm unavailable')) },
      responseGenerator: new TemplateResponseGenerator(),
    });

    const result = await service.query({ corpusId: 'corpus-1', text: 'graph retrieval', topK: 5, topM: 3, threshold: 0.5, contextTokenLimit: 1000 });
    expect(result.response).toContain('Based on 1 sources');
    expect(result.metrics.fallbackTriggered).toBe(true);
  });

  it('disables API-only features in local-only mode', () => {
    const capabilities = new DegradedModePolicy().evaluateCapabilities({ localOnly: true, providers: { llm: { backend: 'openai' }, embedding: { backend: 'openai' }, nlp: { backend: 'regex' } } });
    expect(capabilities.apiFeaturesEnabled).toBe(false);
    expect(capabilities.templateResponseEnabled).toBe(true);
  });
});
