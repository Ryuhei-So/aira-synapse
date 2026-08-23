import { describe, expect, it, vi } from 'vitest';
import { SimplePPR } from '../../../../src/application/query/SimplePPR.js';
import { VectorMemoryFilter } from '../../../../src/application/query/VectorMemoryFilter.js';
import { HybridMemoryFilter } from '../../../../src/application/query/HybridMemoryFilter.js';
import { SimpleContextBuilder } from '../../../../src/application/query/SimpleContextBuilder.js';
import type { IEmbeddingProvider } from '../../../../src/domain/provider/llmProvider.js';
import type { IVectorIndex, IMemoryStore } from '../../../../src/domain/storage/index.js';
import type { ILexicalRetriever, IGraphProjection, TransitionEntry } from '../../../../src/domain/retrieval/ppr.js';
import type { QueryRequest } from '../../../../src/domain/retrieval/memoryFilter.js';
import type { MemorySnapshot } from '../../../../src/domain/memory/globalMemory.js';
import type { Passage } from '../../../../src/domain/memory/passage.js';
import type { Fact } from '../../../../src/domain/memory/fact.js';
import type { Schema } from '../../../../src/domain/memory/schema.js';

const request: QueryRequest = {
  corpusId: 'c1', text: 'Which method is better?', topK: 3, topM: 3,
  threshold: 0.2, contextTokenLimit: 200,
};

const passage = (id: string, text = `text ${id}`): Passage => ({
  passageId: id, corpusId: 'c1', text, normalizedText: text,
  metadata: { documentId: `doc-${id}`, title: id, sourceUrl: `https://${id}`, language: 'en', sectionPath: [], chunkId: id, chunkIndex: 0, offsetStart: 0, offsetEnd: text.length },
  factIds: [], entityMentions: [], qualityFlags: [], createdAt: '', updatedAt: '',
});

const fact = (id: string): Fact => ({
  factId: id, corpusId: 'c1', schemaId: 's1', headEntity: `head-${id}`, headType: 'Method', relation: 'improves', tailEntity: `tail-${id}`, tailType: 'Task', state: 'active', passageIds: [], sourceDocumentIds: [], confidence: 1, createdAt: '', updatedAt: '',
});

const schema = (id: string): Schema => ({
  schemaId: id, corpusId: 'c1', headType: 'Method', relation: 'improves', tailType: 'Task', canonicalKey: `${id}:key`, aliases: [], frequency: 1, state: 'stable', stabilizationThreshold: 1, factIds: [], sourceDocumentIds: [], version: 1,
});

const snapshot = (passages: Passage[] = [passage('p1')], facts: Fact[] = [fact('f1')], schemas: Schema[] = [schema('s1')]): MemorySnapshot => ({
  corpusId: 'c1', exportedAt: '', passages, facts, schemas, schemaVersion: 1,
});

function memoryStore(value = snapshot()): IMemoryStore {
  return { load: vi.fn().mockResolvedValue(value), save: vi.fn(), saveCheckpoint: vi.fn(), loadCheckpoint: vi.fn(), validateIntegrity: vi.fn() };
}

function vectorIndex(matches: Record<string, readonly { id: string; score: number }[]>): IVectorIndex {
  return {
    search: vi.fn(async (req: { namespace: string }) => matches[req.namespace] ?? []),
    upsert: vi.fn(), deleteByDocument: vi.fn(),
  } as unknown as IVectorIndex;
}

function embedding(vectors: readonly number[][]): IEmbeddingProvider {
  return { embed: vi.fn().mockResolvedValue({ model: 'test', vectors, cached: false }), healthCheck: vi.fn() };
}

async function* transitions(entries: readonly TransitionEntry[]): AsyncIterable<TransitionEntry> {
  yield* entries;
}

describe('retrieval-core behavioral boundaries', () => {
  it('returns a converged empty result when the projection has no transitions', async () => {
    const projection: IGraphProjection = { getTransitions: () => transitions([]), getDanglingNodes: vi.fn(), getNodeCount: vi.fn() };
    const result = await new SimplePPR().run({ corpusId: 'c1', initialVector: { scores: {}, fallbackTriggered: false }, teleportProbability: 0.5, convergenceEpsilon: 1e-6, maxIterations: 10, topK: 3, topM: 3 }, projection);
    expect(result).toEqual({ rankedPassages: [], rankedEntities: [], iterations: 0, converged: true, l1Delta: 0 });
  });

  it('ranks passage/fact/schema/entity nodes, normalizes zero seeds, and stops at max iterations', async () => {
    const entries: TransitionEntry[] = [
      { sourceNodeId: 'entity:a', targetNodeId: 'passage:p', weight: 1 },
      { sourceNodeId: 'fact:f', targetNodeId: 'schema:s', weight: 1 },
      { sourceNodeId: 'schema:s', targetNodeId: 'entity:a', weight: 2 },
    ];
    const projection: IGraphProjection = { getTransitions: () => transitions(entries), getDanglingNodes: vi.fn(), getNodeCount: vi.fn() };
    const result = await new SimplePPR(0).run({ corpusId: 'c1', initialVector: { scores: {}, fallbackTriggered: false }, teleportProbability: 0.25, convergenceEpsilon: 0, maxIterations: 2, topK: 1, topM: 10 }, projection);
    expect(result.iterations).toBe(2);
    expect(result.converged).toBe(false);
    expect(result.rankedPassages).toHaveLength(1);
    expect(result.rankedPassages[0]?.layer).toBe('passage');
    expect(result.rankedEntities.map((node) => node.layer)).toEqual(expect.arrayContaining(['fact', 'ontology', 'entity']));
  });

  it('dampens a high-degree schema target without dropping passage ranking', async () => {
    const entries: TransitionEntry[] = Array.from({ length: 3 }, (_, i) => ({ sourceNodeId: `entity:${i}`, targetNodeId: 'schema:hub', weight: 1 }));
    entries.push({ sourceNodeId: 'schema:hub', targetNodeId: 'passage:p', weight: 1 });
    const projection: IGraphProjection = { getTransitions: () => transitions(entries), getDanglingNodes: vi.fn(), getNodeCount: vi.fn() };
    const result = await new SimplePPR(1).run({ corpusId: 'c1', initialVector: { scores: { 'entity:0': 1 }, fallbackTriggered: false }, teleportProbability: 0.5, convergenceEpsilon: 1e-6, maxIterations: 50, topK: 3, topM: 3 }, projection);
    expect(result.rankedPassages[0]?.nodeId).toBe('passage:p');
    expect(result.rankedEntities.some((node) => node.nodeId === 'schema:hub')).toBe(true);
  });

  it('fails closed on an empty embedding and uses a precomputed vector without embedding', async () => {
    const provider = embedding([[]]);
    const filter = new VectorMemoryFilter(provider, vectorIndex({}), memoryStore(), undefined);
    await expect(filter.filter(request)).resolves.toMatchObject({ fallbackRequired: true, queryVector: [] });
    const precomputed = await filter.filter(request, [0.4, 0.6]);
    expect(precomputed.queryVector).toEqual([0.4, 0.6]);
    expect(provider.embed).toHaveBeenCalledTimes(1);
  });

  it('resolves prefixed vector hits and excludes malformed or absent IDs', async () => {
    const index = vectorIndex({
      passage: [{ id: 'passage:p1', score: 0.9 }, { id: 'missing', score: 0.8 }],
      fact: [{ id: 'fact:f1', score: 0.7 }], schema: [{ id: 'schema:s1', score: 0.6 }],
    });
    const result = await new VectorMemoryFilter(embedding([[1, 2]]), index, memoryStore(), undefined).filter(request);
    expect(result.passages.map((x) => x.item.passageId)).toEqual(['p1']);
    expect(result.facts.map((x) => x.item.factId)).toEqual(['f1']);
    expect(result.ontology.map((x) => x.item.schemaId)).toEqual(['s1']);
    expect(result.fallbackRequired).toBe(false);
  });

  it('merges lexical-only hits with attenuation and keeps vector facts/schemas', async () => {
    const lexical: ILexicalRetriever = { search: vi.fn().mockResolvedValue([{ passageId: 'p2', score: 2 }]), indexPassages: vi.fn(), deleteByDocument: vi.fn() };
    const index = vectorIndex({ passage: [{ id: 'p1', score: 0.9 }], fact: [{ id: 'f1', score: 0.8 }], schema: [{ id: 's1', score: 0.7 }] });
    const result = await new HybridMemoryFilter(embedding([[1]]), index, memoryStore(snapshot([passage('p1'), passage('p2')], [fact('f1')], [schema('s1')])), lexical, undefined).filter({ ...request, topK: 2 });
    expect(result.passages.map((x) => x.item.passageId)).toEqual(['p1', 'p2']);
    expect(result.passages[1]?.similarity).toBeLessThan(0.02);
    expect(result.facts).toHaveLength(1);
    expect(result.ontology).toHaveLength(1);
  });

  it('returns fallback for hybrid empty embeddings and absent lexical/vector data', async () => {
    const lexical: ILexicalRetriever = { search: vi.fn().mockResolvedValue([]), indexPassages: vi.fn(), deleteByDocument: vi.fn() };
    const filter = new HybridMemoryFilter(embedding([[]]), vectorIndex({}), memoryStore(snapshot([], [], [])), lexical, undefined);
    await expect(filter.filter(request)).resolves.toMatchObject({ fallbackRequired: true, passages: [], facts: [], ontology: [] });
  });

  it('builds bridge context passages first and comparison context facts first', async () => {
    const store = memoryStore(snapshot([passage('p1', 'passage evidence')], [fact('f1')], []));
    const builder = new SimpleContextBuilder(store);
    const ranking = { rankedPassages: [{ nodeId: 'passage:p1', score: 1, layer: 'passage' as const }], rankedEntities: [{ nodeId: 'fact:f1', score: 1, layer: 'fact' as const }], iterations: 1, converged: true, l1Delta: 0 };
    const bridge = await builder.build({ ...request, text: 'How does it work?' }, ranking);
    expect(bridge.promptContext.indexOf('Relevant Passages')).toBeLessThan(bridge.promptContext.indexOf('Key Facts'));
    const comparison = await builder.build(request, ranking);
    expect(comparison.promptContext.indexOf('Key Facts')).toBeLessThan(comparison.promptContext.indexOf('Relevant Passages'));
    expect(comparison.confidence).toBeGreaterThan(0);
  });

  it('honors the context token bound and ignores missing ranked nodes', async () => {
    const builder = new SimpleContextBuilder(memoryStore(snapshot([passage('p1', 'a very long passage that should not fit')], [], [])));
    const result = await builder.build({ ...request, text: 'plain question', contextTokenLimit: 1 }, { rankedPassages: [{ nodeId: 'passage:missing', score: 1, layer: 'passage' }], rankedEntities: [], iterations: 0, converged: true, l1Delta: 0 });
    expect(result.citedPassages).toEqual([]);
    expect(result.promptContext).toBe('');
    expect(result.confidence).toBe(0);
  });
});
