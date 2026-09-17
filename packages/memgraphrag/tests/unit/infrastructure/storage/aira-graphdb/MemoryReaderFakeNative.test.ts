/**
 * literature-hub #545 §12.3 runtime-adapter fixtures against a fake owner
 * native (tests/support/fake-owner-native.mjs) over the real NativeClient
 * transport: happy path, chunking at the advertised bound, missing-method
 * fail-closed, unknown ids omitted, a generation change between calls, and
 * the query path answering with no memory_load on the wire.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DefaultQueryService } from '../../../../../src/application/query/QueryService.js';
import { SimpleContextBuilder } from '../../../../../src/application/query/SimpleContextBuilder.js';
import { SimpleNodeInitializer } from '../../../../../src/application/query/SimpleNodeInitializer.js';
import { SimplePPR } from '../../../../../src/application/query/SimplePPR.js';
import { VectorMemoryFilter } from '../../../../../src/application/query/VectorMemoryFilter.js';
import type { ITermDictionary } from '../../../../../src/domain/dictionary/termDictionary.js';
import type { Fact } from '../../../../../src/domain/memory/fact.js';
import type { Passage } from '../../../../../src/domain/memory/passage.js';
import type { Schema } from '../../../../../src/domain/memory/schema.js';
import type { IEmbeddingProvider, ILLMProvider } from '../../../../../src/domain/provider/llmProvider.js';
import type { QueryRequest } from '../../../../../src/domain/retrieval/memoryFilter.js';
import type { IMemoryReader, IMemoryStore } from '../../../../../src/domain/storage/index.js';
import { SnapshotBackedMemoryReader } from '../../../../../src/infrastructure/storage/SnapshotBackedMemoryReader.js';
import { CachedGraphProjection } from '../../../../../src/infrastructure/storage/cached/CachedGraphProjection.js';
import { syncProjectionVersion } from '../../../../../src/infrastructure/storage/cached/projectionVersionGate.js';
import { createAiraGraphDbAdapters, type StorageAdapters } from '../../../../../src/infrastructure/storage/ladybug/storageFactory.js';

const FAKE = fileURLToPath(new URL('../../../../support/fake-owner-native.mjs', import.meta.url));
const CORPUS = 'c545';
const NOW = '2026-09-17T00:00:00.000Z';

function passage(passageId: string, text: string): Passage {
  return {
    passageId,
    corpusId: CORPUS,
    text,
    normalizedText: text.toLowerCase(),
    metadata: {
      documentId: `doc-${passageId}`,
      title: `Title ${passageId}`,
      sourceUrl: `https://example.com/${passageId}`,
      language: 'en',
      sectionPath: ['Body'],
      chunkId: `${passageId}:0`,
      chunkIndex: 0,
      offsetStart: 0,
      offsetEnd: text.length,
    },
    factIds: [],
    entityMentions: [],
    qualityFlags: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function legacyPassage(base: Passage, sectionPath: readonly (string | null)[]): Passage {
  return { ...base, metadata: { ...base.metadata, sectionPath: sectionPath as readonly string[] } };
}

function fact(factId: string, headEntity: string, relation: string, tailEntity: string, state: Fact['state'], passageIds: string[]): Fact {
  return {
    factId,
    corpusId: CORPUS,
    schemaId: 's1',
    headEntity,
    headType: 'entity',
    relation,
    tailEntity,
    tailType: 'entity',
    state,
    passageIds,
    sourceDocumentIds: ['doc-p1'],
    confidence: 0.9,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const SCHEMA: Schema = {
  schemaId: 's1',
  corpusId: CORPUS,
  headType: 'entity',
  relation: 'relates',
  tailType: 'entity',
  canonicalKey: 'entity::relates::entity',
  aliases: [],
  frequency: 3,
  state: 'stable',
  stabilizationThreshold: 2,
  factIds: [],
  sourceDocumentIds: ['doc-p1'],
  version: 1,
  createdAt: NOW,
  updatedAt: NOW,
};

const STORE = {
  corpusId: CORPUS,
  passages: [
    // p1 is shaped like the production libfull corpus: chunked before the
    // metadata canonicalisation (bf42f7f), a skipped heading level left a
    // null in sectionPath. The query path must return it exactly as stored.
    legacyPassage(passage('p1', 'Alpha is a method from Germany.'), ['Intro', null, 'Methods']),
    passage('p2', 'Beta is a method from Japan.'),
    passage('p3', 'Ärzte work in Москва.'),
    passage('p4', 'Unrelated passage.'),
    passage('p5', 'Another unrelated passage.'),
  ],
  facts: [
    fact('f-seed1', 'Alpha', 'originates_in', 'Germany', 'active', ['p1']),
    fact('f-seed2', 'Beta', 'originates_in', 'Japan', 'active', ['p2']),
    fact('f-exp1', 'ÄRZTE', 'work_in', 'Москва', 'active', ['p3']),
    fact('f-exp2', 'alpha', 'compared_with', 'BETA', 'inactive', ['p1', 'p2']),
    fact('f-exp3', 'GERMANY', 'capital', 'Berlin', 'active', ['p1']),
    fact('f-exp4', 'москва', 'hosts', 'Ärzte', 'active', ['p3']),
  ],
  schemas: [SCHEMA],
  vectors: {
    passage: [
      { id: 'passage:p1', vector: [1, 0] },
      { id: 'passage:p2', vector: [0.9, 0.1] },
      { id: 'passage:p3', vector: [0, 1] },
      { id: 'passage:p4', vector: [0.5, 0.5] },
      { id: 'passage:p5', vector: [0.4, 0.6] },
    ],
    fact: [
      { id: 'fact:f-seed1', vector: [1, 0.1] },
      { id: 'fact:f-seed2', vector: [0.8, 0.2] },
      { id: 'fact:f-exp1', vector: [0, 1] },
    ],
    schema: [{ id: 'schema:s1', vector: [1, 0] }],
  },
  transitions: [
    { sourceNodeId: 'fact:f-seed1', targetNodeId: 'passage:p1', weight: 1 },
    { sourceNodeId: 'fact:f-seed2', targetNodeId: 'passage:p2', weight: 1 },
    { sourceNodeId: 'fact:f-exp2', targetNodeId: 'passage:p1', weight: 1 },
    { sourceNodeId: 'fact:f-exp2', targetNodeId: 'passage:p2', weight: 1 },
    { sourceNodeId: 'fact:f-exp3', targetNodeId: 'passage:p1', weight: 1 },
    { sourceNodeId: 'passage:p1', targetNodeId: 'fact:f-seed1', weight: 1 },
    { sourceNodeId: 'passage:p2', targetNodeId: 'fact:f-seed2', weight: 1 },
  ],
};

const BRIDGE: QueryRequest = { corpusId: CORPUS, text: 'What is Alpha?', topK: 2, topM: 2, threshold: 0, contextTokenLimit: 400 };
const COMPARISON: QueryRequest = { ...BRIDGE, text: 'Are Alpha and Beta from the same country?' };

const ENV_KEYS = [
  'AIRA_GRAPHDB_NATIVE_CMD',
  'FAKE_OWNER_STORE',
  'FAKE_OWNER_MEMORY_READ_LIMITS',
  'FAKE_OWNER_OMIT_METHODS',
  'FAKE_OWNER_MISCLASSIFY_METHOD',
  'FAKE_OWNER_GENERATION_CHANGE_AFTER',
] as const;
const previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const directories: string[] = [];
let adapters: StorageAdapters | undefined;

function useFake(env: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}): string {
  const directory = mkdtempSync(join(tmpdir(), 'aira-545-fake-'));
  directories.push(directory);
  const storePath = join(directory, 'store.json');
  writeFileSync(storePath, JSON.stringify(STORE));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.AIRA_GRAPHDB_NATIVE_CMD = `${process.execPath} ${FAKE}`;
  process.env.FAKE_OWNER_STORE = storePath;
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  return join(directory, 'db.json');
}

afterEach(async () => {
  if (adapters) {
    await adapters.close();
    adapters = undefined;
  }
  for (const key of ENV_KEYS) {
    const value = previousEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fakeClient(current: StorageAdapters): { request<T>(method: string, params?: unknown): Promise<T> } {
  return (current.lexicalRetriever as unknown as { client: { request<T>(method: string, params?: unknown): Promise<T> } }).client;
}

async function fakeEvents(current: StorageAdapters): Promise<Array<{ method: string; params: Record<string, unknown> }>> {
  return fakeClient(current).request('fake_events');
}

function snapshotReader(): IMemoryReader {
  const store: IMemoryStore = {
    load: vi.fn().mockResolvedValue({
      corpusId: CORPUS, exportedAt: NOW, schemaVersion: 1,
      passages: STORE.passages, facts: STORE.facts, schemas: STORE.schemas,
    }),
    save: vi.fn(), saveCheckpoint: vi.fn(), loadCheckpoint: vi.fn(), validateIntegrity: vi.fn(),
  };
  return new SnapshotBackedMemoryReader(store);
}

function queryService(current: StorageAdapters, reader: IMemoryReader): DefaultQueryService {
  const embedding: IEmbeddingProvider = {
    embed: vi.fn().mockResolvedValue({ model: 'test', vectors: [[1, 0]], cached: false }),
    healthCheck: vi.fn(),
  } as unknown as IEmbeddingProvider;
  const dictionary: ITermDictionary = {
    match: vi.fn().mockResolvedValue([]),
    upsertEntries: vi.fn(),
    suggest: vi.fn().mockResolvedValue([]),
    exportJson: vi.fn().mockResolvedValue({}),
    importJson: vi.fn(),
    getStatistics: vi.fn(),
  } as unknown as ITermDictionary;
  return new DefaultQueryService({
    dictionary,
    expansionPolicy: { expandQuery: async (query: string) => ({ expandedTerms: [], rewrittenQuery: query, originalQuery: query }) },
    memoryFilter: new VectorMemoryFilter(embedding, current.vectorIndex, reader, current.graphStore),
    nodeInitializer: new SimpleNodeInitializer(reader),
    ppr: new SimplePPR(),
    projection: current.graphProjection,
    contextBuilder: new SimpleContextBuilder(reader),
    llm: {} as ILLMProvider,
  });
}

function stable(value: unknown): string {
  return JSON.stringify(value, (key, item: unknown) => (key === 'latencyMs' ? undefined : item));
}

describe('aira-graphdb memory reader against the fake owner native', () => {
  it('happy path: by-id reads in request order, unknown ids omitted, entities under the case fold, counts', async () => {
    adapters = await createAiraGraphDbAdapters({ dbPath: useFake() });
    const reader = adapters.memoryReader;
    expect(reader.bounds).toEqual({ maxIdsPerRequest: 4096, maxEntitiesPerRequest: 64, maxLimit: 100 });

    const passages = await reader.getPassagesByIds({ corpusId: CORPUS, passageIds: ['p3', 'missing', 'p1', 'p3'] });
    expect(passages.map((item) => item.passageId)).toEqual(['p3', 'p1']);
    expect(passages[1]).toEqual(STORE.passages[0]);

    const facts = await reader.getFactsByIds({ corpusId: CORPUS, factIds: ['f-exp2', 'nope', 'f-seed1'] });
    expect(facts.map((item) => item.factId)).toEqual(['f-exp2', 'f-seed1']);

    const schemas = await reader.getSchemasByIds({ corpusId: CORPUS, schemaIds: ['s1', 's9'] });
    expect(schemas).toEqual([SCHEMA]);

    const any = await reader.findFactsByEntities({ corpusId: CORPUS, entities: ['ärzte', 'alpha'], state: 'any', limit: 100 });
    expect(any.map((item) => item.factId)).toEqual(['f-exp1', 'f-exp2', 'f-exp4', 'f-seed1']);
    const active = await reader.findFactsByEntities({ corpusId: CORPUS, entities: ['МОСКВА'], state: 'active', limit: 1 });
    expect(active.map((item) => item.factId)).toEqual(['f-exp1']);

    await expect(reader.sectionCounts({ corpusId: CORPUS })).resolves.toEqual({ passages: 5, facts: 6, schemas: 1 });
    await expect(reader.sectionCounts({ corpusId: 'other' })).resolves.toEqual({ passages: 0, facts: 0, schemas: 0 });

    const events = await fakeEvents(adapters);
    expect(events.map((event) => event.method)).not.toContain('memory_load');
  });

  it('chunks at the advertised bound, not at an assumed number', async () => {
    adapters = await createAiraGraphDbAdapters({ dbPath: useFake({
      FAKE_OWNER_MEMORY_READ_LIMITS: JSON.stringify({ maxIdsPerRequest: 3, maxEntitiesPerRequest: 2, maxLimit: 4 }),
    }) });
    const reader = adapters.memoryReader;
    expect(reader.bounds).toEqual({ maxIdsPerRequest: 3, maxEntitiesPerRequest: 2, maxLimit: 4 });

    const passages = await reader.getPassagesByIds({ corpusId: CORPUS, passageIds: ['p5', 'p4', 'p3', 'p2', 'p1', 'x1', 'x2'] });
    expect(passages.map((item) => item.passageId)).toEqual(['p5', 'p4', 'p3', 'p2', 'p1']);

    const facts = await reader.findFactsByEntities({ corpusId: CORPUS, entities: ['Alpha', 'Beta', 'Germany'], state: 'any', limit: 4 });
    expect(facts.map((item) => item.factId)).toEqual(['f-exp2', 'f-exp3', 'f-seed1', 'f-seed2']);
    await expect(reader.findFactsByEntities({ corpusId: CORPUS, entities: ['Alpha'], state: 'any', limit: 5 }))
      .rejects.toThrow('limit must not exceed the advertised bound 4');

    const events = await fakeEvents(adapters);
    expect(events.filter((event) => event.method === 'memory_get_passages_by_ids').map((event) => event.params.passageIds))
      .toEqual([3, 3, 1]);
    expect(events.filter((event) => event.method === 'memory_find_facts_by_entities').map((event) => event.params.entities))
      .toEqual([2, 1]);
    expect(events.map((event) => event.method)).not.toContain('memory_load');
  });

  it.each([
    ['memory_get_passages_by_ids'],
    ['memory_get_facts_by_ids'],
    ['memory_find_facts_by_entities'],
    ['memory_section_counts'],
  ])('fails closed at startup when the native does not advertise %s', async (missing) => {
    const dbPath = useFake({ FAKE_OWNER_OMIT_METHODS: missing });
    await expect(createAiraGraphDbAdapters({ dbPath })).rejects.toThrow(
      new RegExp(`does not advertise ${missing};.*does not fall back to memory_load`),
    );
  });

  it('fails closed at startup when a memory read is advertised as a mutation', async () => {
    const dbPath = useFake({ FAKE_OWNER_MISCLASSIFY_METHOD: 'memory_get_facts_by_ids' });
    await expect(createAiraGraphDbAdapters({ dbPath })).rejects.toThrow(
      'aira-graphdb method contract mismatch for memory_get_facts_by_ids',
    );
  });

  it('surfaces the owner generation error between calls unchanged and issues no memory_load', async () => {
    adapters = await createAiraGraphDbAdapters({ dbPath: useFake({ FAKE_OWNER_GENERATION_CHANGE_AFTER: '2' }) });
    const reader = adapters.memoryReader;
    await expect(reader.getPassagesByIds({ corpusId: CORPUS, passageIds: ['p1'] })).resolves.toHaveLength(1);
    await expect(reader.getFactsByIds({ corpusId: CORPUS, factIds: ['f-seed1'] })).resolves.toHaveLength(1);
    await expect(reader.getFactsByIds({ corpusId: CORPUS, factIds: ['f-seed2'] })).rejects.toMatchObject({
      code: 'GENERATION_MISMATCH',
      message: 'reader lease generation 7 does not match committed generation 8',
    });
    await expect(reader.findFactsByEntities({ corpusId: CORPUS, entities: ['Alpha'], state: 'any', limit: 10 }))
      .rejects.toMatchObject({ code: 'GENERATION_MISMATCH' });
    const events = await fakeEvents(adapters);
    expect(events.map((event) => event.method)).toEqual([
      'protocol_info', 'protocol_info',
      'memory_get_passages_by_ids', 'memory_get_facts_by_ids', 'memory_get_facts_by_ids', 'memory_find_facts_by_entities',
    ]);
  });

  it('answers the query path from by-id replies while memory_load is withheld, byte-equal to the snapshot path', async () => {
    adapters = await createAiraGraphDbAdapters({ dbPath: useFake() });
    await expect(adapters.memoryStore.load(CORPUS)).rejects.toMatchObject({ code: 'NATIVE_LINE_OVERFLOW' });

    const native = queryService(adapters, adapters.memoryReader);
    const legacy = queryService(adapters, snapshotReader());

    const bridge = await native.retrieve(BRIDGE);
    expect(bridge.passages.map((item) => item.passage.passageId)).toEqual(['p1', 'p2']);
    expect(bridge.contextBundle.promptContext).toContain('Alpha is a method from Germany.');
    expect(bridge.passages[0]!.passage.metadata.sectionPath).toStrictEqual(['Intro', null, 'Methods']);
    expect(stable(bridge)).toBe(stable(await legacy.retrieve(BRIDGE)));

    const comparison = await native.retrieve(COMPARISON);
    expect(comparison.isComparison).toBe(true);
    expect(comparison.pprResult.rankedEntities.map((node) => node.nodeId)).toContain('fact:f-seed1');
    expect(stable(comparison)).toBe(stable(await legacy.retrieve(COMPARISON)));

    const events = await fakeEvents(adapters);
    const methods = events.map((event) => event.method);
    expect(methods.filter((method) => method === 'memory_load')).toEqual(['memory_load']);
    expect(methods.indexOf('memory_load')).toBeLessThan(methods.indexOf('vector_search'));
    expect(methods).toContain('memory_get_passages_by_ids');
    expect(methods).toContain('memory_get_facts_by_ids');
    expect(methods).toContain('memory_get_schemas_by_ids');
    expect(methods).toContain('memory_find_facts_by_entities');
  });

  it('drops the cached ranking graph when the reported generation changes between queries (review M1)', async () => {
    adapters = await createAiraGraphDbAdapters({ dbPath: useFake() });
    expect(adapters.graphProjection).toBeInstanceOf(CachedGraphProjection);
    const service = queryService(adapters, adapters.memoryReader);
    const transitionsPulled = async () => (await fakeEvents(adapters!))
      .filter((event) => event.method === 'projection_get_transitions').length;

    // Same generation across queries: one projection pull per process.
    await expect(syncProjectionVersion(adapters.graphProjection, adapters.readGeneration)).resolves.toBe(false);
    await service.retrieve(BRIDGE);
    await expect(syncProjectionVersion(adapters.graphProjection, adapters.readGeneration)).resolves.toBe(false);
    await service.retrieve(BRIDGE);
    expect(await transitionsPulled()).toBe(1);

    // The index worker commits: protocol_info reports a new generation and
    // the next query reloads the graph.
    await fakeClient(adapters).request('fake_set_generation', { generation: 8 });
    await expect(syncProjectionVersion(adapters.graphProjection, adapters.readGeneration)).resolves.toBe(true);
    await service.retrieve(BRIDGE);
    expect(await transitionsPulled()).toBe(2);
    expect((adapters.graphProjection as CachedGraphProjection).observedVersion).toBe(8);
  });

  it('expands comparison seeds through findFactsByEntities with the same scores as the snapshot scan', async () => {
    adapters = await createAiraGraphDbAdapters({ dbPath: useFake() });
    const candidates = {
      ontology: [],
      passages: [],
      facts: [
        { layer: 'fact' as const, item: STORE.facts[0]!, similarity: 0.8 },
        { layer: 'fact' as const, item: STORE.facts[1]!, similarity: 0.5 },
      ],
      expandedTerms: [],
      fallbackRequired: false,
      queryVector: [1, 0],
    };
    const viaNative = await new SimpleNodeInitializer(adapters.memoryReader).initialize({ query: COMPARISON, candidates });
    const viaSnapshot = await new SimpleNodeInitializer(snapshotReader()).initialize({ query: COMPARISON, candidates });
    expect(viaNative).toEqual(viaSnapshot);
    // alpha/BETA (inactive, folded) and GERMANY (folded) join through the seed entities.
    expect(viaNative.scores['fact:f-exp2']).toBeCloseTo(0.8 * 0.3);
    expect(viaNative.scores['fact:f-exp3']).toBeCloseTo(0.8 * 0.3);
    expect(viaNative.scores['fact:f-exp1']).toBeUndefined();
    const events = await fakeEvents(adapters);
    expect(events.filter((event) => event.method === 'memory_find_facts_by_entities')).toHaveLength(1);
    expect(events.map((event) => event.method)).not.toContain('memory_load');
  });
});
