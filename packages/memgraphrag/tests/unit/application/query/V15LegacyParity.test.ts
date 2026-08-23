import { describe, expect, it, vi } from 'vitest';
import type { IEmbeddingProvider } from '../../../../src/domain/provider/index.js';
import type { Fact } from '../../../../src/domain/memory/fact.js';
import type { Passage } from '../../../../src/domain/memory/passage.js';
import type { MemorySnapshot } from '../../../../src/domain/memory/globalMemory.js';
import type { IVectorIndex, IMemoryStore, VectorSearchMatch } from '../../../../src/domain/storage/index.js';
import type { QueryRequest } from '../../../../src/domain/retrieval/memoryFilter.js';
import type { IGraphProjection, TransitionEntry } from '../../../../src/domain/retrieval/ppr.js';
import { VectorMemoryFilter } from '../../../../src/application/query/VectorMemoryFilter.js';
import { SimpleNodeInitializer } from '../../../../src/application/query/SimpleNodeInitializer.js';
import { SimplePPR } from '../../../../src/application/query/SimplePPR.js';

const query: QueryRequest = {
  corpusId: 'corpus-1',
  text: 'Which entity is larger?',
  topK: 2,
  topM: 2,
  threshold: -0.4,
  contextTokenLimit: 128,
};

describe('v15 legacy path parity hardenings', () => {
  it('uses shared candidate slots and preserves signed negative-threshold search semantics', async () => {
    const searchCalls: Array<{ namespace: string; threshold?: number; topK: number }> = [];
    const embeddingProvider: IEmbeddingProvider = {
      embed: vi.fn().mockResolvedValue({ vectors: [[1, 0]] }),
    } as IEmbeddingProvider;
    const vectorIndex: IVectorIndex = {
      upsert: vi.fn(),
      deleteByDocument: vi.fn(),
      search: vi.fn().mockImplementation(async (request) => {
        searchCalls.push({ namespace: request.namespace, threshold: request.threshold, topK: request.topK });
        const rows: Record<string, VectorSearchMatch<Record<string, never>>[]> = {
          passage: [
            { id: 'passage:p2', score: -0.1, metadata: {} },
            { id: 'passage:p1', score: -0.1, metadata: {} },
          ],
          fact: [{ id: 'fact:f1', score: -0.2, metadata: {} }],
          schema: [],
        };
        return rows[request.namespace] ?? [];
      }),
    };
    const memory = makeMemoryStore({ passages: [makePassage('p1'), makePassage('p2')], facts: [makeFact('f1')], schemas: [] });
    const filter = new VectorMemoryFilter(embeddingProvider, vectorIndex, memory, undefined);

    const result = await filter.filter(query);

    expect(searchCalls).toEqual([
      { namespace: 'passage', threshold: -0.4, topK: 2 },
      { namespace: 'fact', threshold: -0.4, topK: 2 },
      { namespace: 'schema', threshold: -0.4, topK: 10 },
    ]);
    expect(result.passages.map((candidate) => candidate.item.passageId)).toEqual(['p1', 'p2']);
    expect(result.passages.map((candidate) => candidate.similarity)).toEqual([-0.1, -0.1]);
  });

  it('keeps inactive facts and applies the explicit zero-floor plus fact-id tie order', async () => {
    const initializer = new SimpleNodeInitializer(makeMemoryStore({
      passages: [],
      schemas: [],
      facts: [makeFact('f-seed'), makeFact('f-z'), makeFact('f-a')],
    }));
    const result = await initializer.initialize({
      query,
      candidates: {
        ontology: [],
        passages: [],
        facts: [{ layer: 'fact', item: makeFact('f-seed'), similarity: -0.25 }],
        expandedTerms: [],
        fallbackRequired: false,
        queryVector: [1, 0],
      },
    });

    expect(result.scores['fact:f-seed']).toBe(-0.25);
    expect(result.scores['fact:f-a']).toBe(0);
    expect(result.scores['fact:f-z']).toBe(0);
    expect(Object.keys(result.scores)).toEqual(['fact:f-seed', 'fact:f-a', 'fact:f-z']);
  });

  it('canonicalizes graph and ranked ties while retaining algebraic signed seed normalization', async () => {
    const transitions: TransitionEntry[] = [
      { sourceNodeId: 'fact:a', targetNodeId: 'passage:z', weight: 1 },
      { sourceNodeId: 'fact:a', targetNodeId: 'passage:a', weight: 1 },
    ];
    const projection: IGraphProjection = {
      getTransitions: async function* () {
        yield transitions[0]!;
        yield transitions[1]!;
      },
      getDanglingNodes: vi.fn().mockResolvedValue([]),
      getNodeCount: vi.fn().mockResolvedValue(3),
    };
    const result = await new SimplePPR().run({
      corpusId: 'corpus-1',
      initialVector: { scores: { 'fact:a': 1, 'fact:z': -0.5 }, fallbackTriggered: false },
      teleportProbability: 0.5,
      convergenceEpsilon: 1e-12,
      maxIterations: 1,
      topK: 2,
      topM: 1,
    }, projection);

    expect(result.rankedPassages.map((node) => node.nodeId)).toEqual(['passage:a', 'passage:z']);
    expect(result.rankedPassages[0]?.score).toBeCloseTo(result.rankedPassages[1]?.score ?? 0, 12);
  });
});

function makeMemoryStore(snapshot: Pick<MemorySnapshot, 'passages' | 'facts' | 'schemas'>): IMemoryStore {
  const fullSnapshot = {
    ...snapshot,
    corpusId: 'corpus-1',
    exportedAt: '2026-01-01T00:00:00Z',
    schemaVersion: 1,
  } as MemorySnapshot;
  return {
    load: vi.fn().mockResolvedValue(fullSnapshot),
    save: vi.fn(),
    saveCheckpoint: vi.fn(),
    loadCheckpoint: vi.fn(),
    validateIntegrity: vi.fn(),
  };
}

function makePassage(id: string): Passage {
  return {
    corpusId: 'corpus-1',
    passageId: id,
    text: id,
    normalizedText: id,
    metadata: {
      documentId: `doc-${id}`,
      title: id,
      sourceUrl: `https://example.com/${id}`,
      language: 'en',
      sectionPath: [],
      chunkId: id,
      chunkIndex: 0,
      offsetStart: 0,
      offsetEnd: 1,
    },
    factIds: [],
    entityMentions: [],
    qualityFlags: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function makeFact(id: string): Fact {
  return {
    corpusId: 'corpus-1',
    factId: id,
    schemaId: 'schema-1',
    headEntity: 'Alpha',
    headType: 'Entity',
    relation: 'relates',
    tailEntity: 'Beta',
    tailType: 'Entity',
    state: 'inactive',
    passageIds: [],
    sourceDocumentIds: [],
    confidence: 0.8,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}
