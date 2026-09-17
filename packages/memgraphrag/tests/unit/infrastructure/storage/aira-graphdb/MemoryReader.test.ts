import { describe, expect, it, vi } from 'vitest';

import type { Fact } from '../../../../../src/domain/memory/fact.js';
import type { Passage } from '../../../../../src/domain/memory/passage.js';
import type { Schema } from '../../../../../src/domain/memory/schema.js';
import { INDEXING_MEMORY_CONTRACT } from '../../../../../src/domain/storage/indexingMemory.js';
import { MEMORY_READ_CONTRACT } from '../../../../../src/domain/storage/memoryReader.js';
import {
  AiraGraphDbMemoryReader,
  validateMemoryReadProtocolInfo,
} from '../../../../../src/infrastructure/storage/aira-graphdb/AiraGraphDbMemoryReader.js';
import type { AiraGraphDbRpcClient } from '../../../../../src/infrastructure/storage/aira-graphdb/NativeClient.js';
import { SnapshotBackedMemoryReader } from '../../../../../src/infrastructure/storage/SnapshotBackedMemoryReader.js';
import type { IMemoryStore } from '../../../../../src/domain/storage/graphStore.js';

const NOW = '2026-09-17T00:00:00.000Z';
const CORPUS = 'c545';

function memoryReadMethods(): Array<Record<string, unknown>> {
  return [
    { name: 'memory_get_schemas_by_ids', classification: 'read', wal: false },
    { name: 'memory_get_active_facts', classification: 'read', wal: false },
    { name: 'memory_activate_facts_by_schema_ids', classification: 'mutation', wal: true },
    { name: 'memory_upsert', classification: 'mutation', wal: true },
    { name: 'memory_load', classification: 'read', wal: false },
    ...MEMORY_READ_CONTRACT.methods.map((name) => ({ name, classification: 'read', wal: false })),
  ];
}

function protocolInfo(
  overrides: Record<string, unknown> = {},
  memoryRead: Record<string, unknown> = { schema: 'native-memory-read@1', maxIdsPerRequest: 3, maxEntitiesPerRequest: 2, maxLimit: 5 },
): Record<string, unknown> {
  return {
    protocolVersion: 'native-method-policy@1',
    generation: 7,
    state: 'idle',
    limits: {
      indexingMemory: { ...INDEXING_MEMORY_CONTRACT },
      memoryRead,
      wal: { mutationRequestIdUniqueness: 'activeTransaction' },
    },
    methods: memoryReadMethods(),
    ...overrides,
  };
}

function passage(passageId: string): Passage {
  return {
    passageId,
    corpusId: CORPUS,
    text: `text of ${passageId}`,
    normalizedText: `text of ${passageId}`,
    metadata: {
      documentId: 'd1',
      title: 'Document',
      sourceUrl: 'https://example.com/d1',
      language: 'en',
      sectionPath: [],
      chunkId: passageId,
      chunkIndex: 0,
      offsetStart: 0,
      offsetEnd: 1,
    },
    factIds: [],
    entityMentions: [],
    qualityFlags: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function fact(factId: string, headEntity = 'Alpha', tailEntity = 'Beta', state: Fact['state'] = 'active'): Fact {
  return {
    factId,
    corpusId: CORPUS,
    schemaId: 's1',
    headEntity,
    headType: 'entity',
    relation: 'relates',
    tailEntity,
    tailType: 'entity',
    state,
    passageIds: ['p1'],
    sourceDocumentIds: ['d1'],
    confidence: 0.9,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function schema(schemaId: string): Schema {
  return {
    schemaId,
    corpusId: CORPUS,
    headType: 'entity',
    relation: 'relates',
    tailType: 'entity',
    canonicalKey: 'entity::relates::entity',
    aliases: [],
    frequency: 1,
    state: 'stable',
    stabilizationThreshold: 1,
    factIds: [],
    sourceDocumentIds: ['d1'],
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

type Handler = (method: string, params: unknown) => unknown;

function clientWith(handler: Handler, protocol: Record<string, unknown> = protocolInfo()): {
  client: AiraGraphDbRpcClient;
  calls: Array<{ method: string; params: unknown }>;
} {
  const calls: Array<{ method: string; params: unknown }> = [];
  const request = vi.fn(async (method: string, params?: unknown) => {
    calls.push({ method, params });
    if (method === 'protocol_info') return protocol;
    return handler(method, params);
  });
  return { client: { request } as AiraGraphDbRpcClient, calls };
}

function byIdHandler(store: { passages?: Passage[]; facts?: Fact[]; schemas?: Schema[] }): Handler {
  return (method, params) => {
    const { corpusId } = params as { corpusId: string };
    expect(corpusId).toBe(CORPUS);
    if (method === 'memory_get_passages_by_ids') {
      const ids = (params as { passageIds: string[] }).passageIds;
      return ids.flatMap((id) => (store.passages ?? []).filter((item) => item.passageId === id));
    }
    if (method === 'memory_get_facts_by_ids') {
      const ids = (params as { factIds: string[] }).factIds;
      return ids.flatMap((id) => (store.facts ?? []).filter((item) => item.factId === id));
    }
    if (method === 'memory_get_schemas_by_ids') {
      const ids = (params as { schemaIds: string[] }).schemaIds;
      return ids.flatMap((id) => (store.schemas ?? []).filter((item) => item.schemaId === id));
    }
    throw new Error(`unexpected ${method}`);
  };
}

describe('AiraGraphDbMemoryReader startup validation (fail closed, no probing)', () => {
  it('accepts the advertised inventory and takes the bounds from limits.memoryRead', async () => {
    const { client, calls } = clientWith(() => null);
    const reader = await AiraGraphDbMemoryReader.create(client);
    expect(reader.bounds).toEqual({ maxIdsPerRequest: 3, maxEntitiesPerRequest: 2, maxLimit: 5 });
    expect(calls.map((call) => call.method)).toEqual(['protocol_info']);
  });

  it.each(MEMORY_READ_CONTRACT.methods)('names %s when the native does not advertise it', async (missing) => {
    const protocol = protocolInfo({ methods: memoryReadMethods().filter((method) => method.name !== missing) });
    const { client, calls } = clientWith(() => null, protocol);
    await expect(AiraGraphDbMemoryReader.create(client)).rejects.toThrow(
      new RegExp(`does not advertise ${missing};.*does not fall back to memory_load`),
    );
    expect(calls.map((call) => call.method)).toEqual(['protocol_info']);
  });

  it('rejects a memory read method advertised as a mutation or as WAL intent', async () => {
    const misclassified = memoryReadMethods().map((method) => (
      method.name === 'memory_get_facts_by_ids' ? { ...method, classification: 'mutation' } : method
    ));
    const { client } = clientWith(() => null, protocolInfo({ methods: misclassified }));
    await expect(AiraGraphDbMemoryReader.create(client)).rejects.toThrow(
      'aira-graphdb method contract mismatch for memory_get_facts_by_ids',
    );
    const walBearing = memoryReadMethods().map((method) => (
      method.name === 'memory_section_counts' ? { ...method, wal: true } : method
    ));
    await expect(AiraGraphDbMemoryReader.create(clientWith(() => null, protocolInfo({ methods: walBearing })).client))
      .rejects.toThrow('aira-graphdb method contract mismatch for memory_section_counts');
  });

  it.each([
    ['absent', null, 'protocol_info.limits.memoryRead must be an object'],
    ['wrong schema', { schema: 'native-memory-read@2', maxIdsPerRequest: 3, maxEntitiesPerRequest: 2, maxLimit: 5 }, 'schema must be native-memory-read@1'],
    ['missing bound', { schema: 'native-memory-read@1', maxIdsPerRequest: 3, maxLimit: 5 }, 'maxEntitiesPerRequest must be a positive safe integer'],
    ['zero bound', { schema: 'native-memory-read@1', maxIdsPerRequest: 0, maxEntitiesPerRequest: 2, maxLimit: 5 }, 'maxIdsPerRequest must be a positive safe integer'],
    ['fractional bound', { schema: 'native-memory-read@1', maxIdsPerRequest: 3, maxEntitiesPerRequest: 2, maxLimit: 5.5 }, 'maxLimit must be a positive safe integer'],
  ])('fails closed when limits.memoryRead is %s', async (_label, memoryRead, message) => {
    const { client } = clientWith(() => null, protocolInfo({}, memoryRead as unknown as Record<string, unknown>));
    await expect(AiraGraphDbMemoryReader.create(client)).rejects.toThrow(message);
  });

  it('rejects an unknown protocol version and a malformed method inventory', () => {
    expect(() => validateMemoryReadProtocolInfo(protocolInfo({ protocolVersion: 'native-method-policy@2' })))
      .toThrow('unsupported aira-graphdb protocolVersion');
    expect(() => validateMemoryReadProtocolInfo(protocolInfo({ methods: 'nope' })))
      .toThrow('protocol_info.methods must be an array');
    expect(() => validateMemoryReadProtocolInfo(protocolInfo({ methods: [...memoryReadMethods(), { name: 'memory_load', classification: 'read', wal: false }] })))
      .toThrow('invalid or duplicate name');
  });
});

describe('AiraGraphDbMemoryReader by-id reads', () => {
  it('chunks at the advertised maxIdsPerRequest, keeps request order and omits unknown ids', async () => {
    const store = { passages: ['p1', 'p2', 'p3', 'p4', 'p5', 'p7'].map(passage) };
    const { client, calls } = clientWith(byIdHandler(store));
    const reader = await AiraGraphDbMemoryReader.create(client);

    const result = await reader.getPassagesByIds({
      corpusId: CORPUS,
      passageIds: ['p7', 'p1', 'missing', 'p1', 'p3', '', 'p5', 'p2', 'x'.repeat(INDEXING_MEMORY_CONTRACT.maxDomainIdBytes + 1)],
    });

    expect(result.map((item) => item.passageId)).toEqual(['p7', 'p1', 'p3', 'p5', 'p2']);
    const reads = calls.filter((call) => call.method === 'memory_get_passages_by_ids');
    expect(reads.map((call) => (call.params as { passageIds: string[] }).passageIds)).toEqual([
      ['p7', 'p1', 'missing'],
      ['p3', 'p5', 'p2'],
    ]);
    expect(calls.some((call) => call.method === 'memory_load')).toBe(false);
  });

  it('issues no request for an empty id list', async () => {
    const { client, calls } = clientWith(byIdHandler({}));
    const reader = await AiraGraphDbMemoryReader.create(client);
    await expect(reader.getFactsByIds({ corpusId: CORPUS, factIds: [] })).resolves.toEqual([]);
    await expect(reader.getFactsByIds({ corpusId: CORPUS, factIds: ['', 'x'.repeat(5000)] })).resolves.toEqual([]);
    expect(calls.map((call) => call.method)).toEqual(['protocol_info']);
  });

  it('bounds schema reads by the advertised maxSchemaIds, not by maxIdsPerRequest', async () => {
    const protocol = protocolInfo();
    (protocol.limits as Record<string, Record<string, unknown>>).indexingMemory = { ...INDEXING_MEMORY_CONTRACT, maxSchemaIds: 2 };
    const store = { schemas: ['s1', 's2', 's3'].map(schema) };
    const { client, calls } = clientWith(byIdHandler(store), protocol);
    const reader = await AiraGraphDbMemoryReader.create(client);
    const result = await reader.getSchemasByIds({ corpusId: CORPUS, schemaIds: ['s3', 's1', 's2'] });
    expect(result.map((item) => item.schemaId)).toEqual(['s3', 's1', 's2']);
    expect(calls.filter((call) => call.method === 'memory_get_schemas_by_ids')).toHaveLength(2);
  });

  it.each([
    ['an unrequested id', () => [passage('p9')], 'unrequested passage id'],
    ['an out-of-order reply', () => [passage('p2'), passage('p1')], 'not in request order'],
    ['a repeated id', () => [passage('p1'), passage('p1')], 'not in request order or repeats'],
    ['a foreign corpus', () => [{ ...passage('p1'), corpusId: 'other' }], 'corpusId must match the requested corpus'],
    ['a contract violation', () => [{ ...passage('p1'), text: 7 }], 'violates the Synapse domain contract'],
    ['a non-array', () => null, 'must be an array no larger than the request'],
    ['more items than requested', () => [passage('p1'), passage('p2'), passage('p1')], 'must be an array no larger than the request'],
  ])('rejects %s', async (_label, reply, message) => {
    const { client } = clientWith(() => reply());
    const reader = await AiraGraphDbMemoryReader.create(client);
    await expect(reader.getPassagesByIds({ corpusId: CORPUS, passageIds: ['p1', 'p2'] })).rejects.toThrow(message);
  });

  it('surfaces a native error unchanged and never retries through memory_load', async () => {
    const { client, calls } = clientWith(() => {
      const error = new Error('reader lease generation 7 does not match committed generation 8') as Error & { code?: string };
      error.code = 'GENERATION_MISMATCH';
      throw error;
    });
    const reader = await AiraGraphDbMemoryReader.create(client);
    await expect(reader.getFactsByIds({ corpusId: CORPUS, factIds: ['f1'] }))
      .rejects.toMatchObject({ code: 'GENERATION_MISMATCH', message: 'reader lease generation 7 does not match committed generation 8' });
    expect(calls.map((call) => call.method)).toEqual(['protocol_info', 'memory_get_facts_by_ids']);
  });
});

describe('AiraGraphDbMemoryReader stored objects that predate the write contract (literature-hub #545 rollback)', () => {
  /** A libfull-shaped passage: the pre-bf42f7f chunker left holes in sectionPath that became null on the wire. */
  function legacyPassage(sectionPath: unknown): Passage {
    const base = passage('p-legacy');
    return { ...base, metadata: { ...base.metadata, sectionPath: sectionPath as readonly string[] } };
  }

  function snapshotStore(passages: Passage[]): IMemoryStore {
    return {
      load: vi.fn().mockResolvedValue({ corpusId: CORPUS, exportedAt: NOW, schemaVersion: 1, passages, facts: [], schemas: [] }),
      save: vi.fn(), saveCheckpoint: vi.fn(), loadCheckpoint: vi.fn(), validateIntegrity: vi.fn(),
    };
  }

  it('hands a null sectionPath element through untouched, identical to the snapshot reader', async () => {
    const stored = legacyPassage(['Intro', null, 'Sub']);
    const { client } = clientWith(byIdHandler({ passages: [stored] }));
    const native = await AiraGraphDbMemoryReader.create(client);
    const legacy = new SnapshotBackedMemoryReader(snapshotStore([stored]));
    const request = { corpusId: CORPUS, passageIds: ['p-legacy'] };

    const [fromNative, fromSnapshot] = await Promise.all([native.getPassagesByIds(request), legacy.getPassagesByIds(request)]);

    expect(fromNative).toStrictEqual(fromSnapshot);
    expect(JSON.stringify(fromNative)).toBe(JSON.stringify(fromSnapshot));
    expect(fromNative[0]!.metadata.sectionPath).toStrictEqual(['Intro', null, 'Sub']);
    // The stored object itself is returned, not a validated copy.
    expect(fromNative[0]).toBe(stored);
  });

  it.each([
    ['a passage without text', () => { const { text: _text, ...rest } = legacyPassage(['Intro', null]); return rest; }, '$.text is required'],
    ['a passage without passageId', () => { const { passageId: _id, ...rest } = legacyPassage(['Intro', null]); return rest; }, '$.passageId is required'],
    ['a sectionPath that is not an array', () => legacyPassage('Intro'), '$.metadata.sectionPath must be an array'],
    ['a sparse sectionPath', () => legacyPassage([, 'Intro']), '$.metadata.sectionPath[0] must not be sparse'],
    ['a number sectionPath element (never stored; only null was measured)', () => legacyPassage(['Intro', 2, null]), '$.metadata.sectionPath[1] must be a string'],
    ['an object sectionPath element', () => legacyPassage(['Intro', { title: 'Sub' }]), '$.metadata.sectionPath[1] must be a string'],
    ['an unknown metadata field', () => { const item = legacyPassage(['Intro', null]); return { ...item, metadata: { ...item.metadata, extra: 1 } }; }, '$.metadata.extra is an unknown field'],
    ['an empty offset range', () => { const item = legacyPassage(['Intro', null]); return { ...item, metadata: { ...item.metadata, offsetEnd: 0 } }; }, 'offsets must describe a non-empty range'],
  ])('still fails closed on %s', async (_label, reply, message) => {
    const { client } = clientWith(() => [reply()]);
    const reader = await AiraGraphDbMemoryReader.create(client);
    await expect(reader.getPassagesByIds({ corpusId: CORPUS, passageIds: ['p-legacy'] })).rejects.toThrow(message);
  });

  it.each([
    ['fact', (reader: AiraGraphDbMemoryReader) => reader.getFactsByIds({ corpusId: CORPUS, factIds: ['f1'] }), () => [{ ...fact('f1'), confidence: 'high' }], '$.confidence must be a finite number'],
    ['schema', (reader: AiraGraphDbMemoryReader) => reader.getSchemasByIds({ corpusId: CORPUS, schemaIds: ['s1'] }), () => [{ ...schema('s1'), aliases: [null] }], '$.aliases[0] must be an object'],
  ])('keeps the write contract for a stored %s (no deviation measured in any production corpus)', async (_kind, read, reply, message) => {
    const { client } = clientWith(() => reply());
    const reader = await AiraGraphDbMemoryReader.create(client);
    await expect(read(reader)).rejects.toThrow(message);
  });
});

describe('AiraGraphDbMemoryReader entity reads', () => {
  const facts = [
    fact('f-b', 'Ärzte', 'Beta'),
    fact('f-a', 'Alpha', 'ÄRZTE', 'inactive'),
    fact('f-d', 'Москва', 'Gamma'),
    fact('f-c', 'Delta', 'москва'),
    fact('f-e', 'Alpha', 'Beta'),
  ];
  const fold = (value: string) => value.toLowerCase();
  const nativeLike: Handler = (method, params) => {
    expect(method).toBe('memory_find_facts_by_entities');
    const { entities, state, limit } = params as { entities: string[]; state: string; limit: number };
    const wanted = new Set(entities.map(fold));
    return facts
      .filter((item) => (state === 'any' || item.state === 'active')
        && (wanted.has(fold(item.headEntity)) || wanted.has(fold(item.tailEntity))))
      .sort((left, right) => (left.factId < right.factId ? -1 : 1))
      .slice(0, limit);
  };

  it('chunks entities at the advertised bound and merges to one ordered, truncated prefix', async () => {
    const { client, calls } = clientWith(nativeLike);
    const reader = await AiraGraphDbMemoryReader.create(client);
    const result = await reader.findFactsByEntities({
      corpusId: CORPUS,
      entities: ['ärzte', 'МОСКВА', 'Alpha', 'ärzte'],
      state: 'any',
      limit: 4,
    });
    expect(result.map((item) => item.factId)).toEqual(['f-a', 'f-b', 'f-c', 'f-d']);
    const reads = calls.filter((call) => call.method === 'memory_find_facts_by_entities');
    expect(reads.map((call) => (call.params as { entities: string[] }).entities)).toEqual([
      ['ärzte', 'МОСКВА'],
      ['Alpha'],
    ]);
    expect(reads.every((call) => (call.params as { limit: number }).limit === 4)).toBe(true);
  });

  it('truncates to the advertised maxLimit (the native residual the snapshot path does not have)', async () => {
    const many = Array.from({ length: 7 }, (_, index) => fact(`f-${index}`, 'Alpha', `Tail ${index}`));
    const { client } = clientWith((_method, params) => many.slice(0, (params as { limit: number }).limit));
    const reader = await AiraGraphDbMemoryReader.create(client);
    const result = await reader.findFactsByEntities({ corpusId: CORPUS, entities: ['Alpha'], state: 'any', limit: reader.bounds.maxLimit });
    expect(result.map((item) => item.factId)).toEqual(['f-0', 'f-1', 'f-2', 'f-3', 'f-4']);
  });

  it('applies the state filter and returns [] without a request for limit 0 or no entities', async () => {
    const { client, calls } = clientWith(nativeLike);
    const reader = await AiraGraphDbMemoryReader.create(client);
    await expect(reader.findFactsByEntities({ corpusId: CORPUS, entities: ['Ärzte'], state: 'active', limit: 5 }))
      .resolves.toEqual([facts[0]]);
    await expect(reader.findFactsByEntities({ corpusId: CORPUS, entities: ['Ärzte'], state: 'any', limit: 0 })).resolves.toEqual([]);
    await expect(reader.findFactsByEntities({ corpusId: CORPUS, entities: [''], state: 'any', limit: 5 })).resolves.toEqual([]);
    expect(calls.filter((call) => call.method === 'memory_find_facts_by_entities')).toHaveLength(1);
  });

  it('rejects a limit above the advertised maxLimit and an unknown state before any request', async () => {
    const { client, calls } = clientWith(nativeLike);
    const reader = await AiraGraphDbMemoryReader.create(client);
    await expect(reader.findFactsByEntities({ corpusId: CORPUS, entities: ['Alpha'], state: 'any', limit: 6 }))
      .rejects.toThrow('limit must not exceed the advertised bound 5');
    await expect(reader.findFactsByEntities({ corpusId: CORPUS, entities: ['Alpha'], state: 'all' as 'any', limit: 1 }))
      .rejects.toThrow('state must be "active" or "any"');
    expect(calls.map((call) => call.method)).toEqual(['protocol_info']);
  });

  it.each([
    ['a fact matching no requested entity under the pinned fold', () => [fact('f-z', 'Omega', 'Psi')], 'matches no requested entity'],
    ['a non-ascending reply', () => [fact('f-b', 'Alpha'), fact('f-a', 'Alpha')], 'not strictly ascending by factId'],
    ['a repeated factId', () => [fact('f-a', 'Alpha'), fact('f-a', 'Alpha')], 'not strictly ascending by factId'],
    ['an inactive fact under state active', () => [fact('f-a', 'Alpha', 'Beta', 'inactive')], 'contains a non-active fact'],
    ['more facts than the limit', () => [fact('f-a', 'Alpha'), fact('f-b', 'Alpha'), fact('f-c', 'Alpha')], 'no larger than the requested limit'],
  ])('rejects %s', async (_label, reply, message) => {
    const { client } = clientWith(() => reply());
    const reader = await AiraGraphDbMemoryReader.create(client);
    await expect(reader.findFactsByEntities({ corpusId: CORPUS, entities: ['Alpha'], state: 'active', limit: 2 }))
      .rejects.toThrow(message);
  });
});

describe('AiraGraphDbMemoryReader section counts', () => {
  it('returns the three counts and rejects any other shape', async () => {
    let reply: unknown = { passages: 3, facts: 5, schemas: 1 };
    const { client } = clientWith(() => reply);
    const reader = await AiraGraphDbMemoryReader.create(client);
    await expect(reader.sectionCounts({ corpusId: CORPUS })).resolves.toEqual({ passages: 3, facts: 5, schemas: 1 });
    reply = { passages: 3, facts: 5 };
    await expect(reader.sectionCounts({ corpusId: CORPUS })).rejects.toThrow('exactly passages, facts and schemas');
    reply = { passages: -1, facts: 5, schemas: 1 };
    await expect(reader.sectionCounts({ corpusId: CORPUS })).rejects.toThrow('passages must be a nonnegative safe integer');
  });
});

describe('SnapshotBackedMemoryReader parity with the native semantics', () => {
  function snapshotStore(items: { passages?: Passage[]; facts?: Fact[]; schemas?: Schema[] }): IMemoryStore {
    return {
      load: vi.fn().mockResolvedValue({
        corpusId: CORPUS, exportedAt: NOW, schemaVersion: 1,
        passages: items.passages ?? [], facts: items.facts ?? [], schemas: items.schemas ?? [],
      }),
      save: vi.fn(), saveCheckpoint: vi.fn(), loadCheckpoint: vi.fn(), validateIntegrity: vi.fn(),
    };
  }

  it('answers by-id and by-entity reads with the same order, omission and fold rules', async () => {
    const reader = new SnapshotBackedMemoryReader(snapshotStore({
      passages: ['p1', 'p2'].map(passage),
      facts: [fact('f-b', 'Ärzte', 'Beta'), fact('f-a', 'Alpha', 'ÄRZTE', 'inactive'), fact('f-c', 'Alpha', 'Beta')],
    }));
    await expect(reader.getPassagesByIds({ corpusId: CORPUS, passageIds: ['p2', 'nope', 'p1', 'p2'] }))
      .resolves.toEqual([passage('p2'), passage('p1')]);
    const any = await reader.findFactsByEntities({ corpusId: CORPUS, entities: ['ärzte'], state: 'any', limit: 10 });
    expect(any.map((item) => item.factId)).toEqual(['f-a', 'f-b']);
    const active = await reader.findFactsByEntities({ corpusId: CORPUS, entities: ['ärzte'], state: 'active', limit: 10 });
    expect(active.map((item) => item.factId)).toEqual(['f-b']);
    await expect(reader.sectionCounts({ corpusId: CORPUS })).resolves.toEqual({ passages: 2, facts: 3, schemas: 0 });
  });

  it('advertises no bound and keeps the legacy unbounded scan (review M2)', async () => {
    const many = Array.from({ length: 150 }, (_, index) => fact(`f-${String(index).padStart(3, '0')}`, 'Alpha', `Tail ${index}`));
    const reader = new SnapshotBackedMemoryReader(snapshotStore({ facts: many }));
    expect(reader.bounds.maxLimit).toBe(Number.MAX_SAFE_INTEGER);
    const all = await reader.findFactsByEntities({ corpusId: CORPUS, entities: ['alpha'], state: 'any', limit: reader.bounds.maxLimit });
    expect(all).toHaveLength(150);
    expect(all.map((item) => item.factId)).toEqual(many.map((item) => item.factId));
    const ids = many.map((item) => item.factId);
    await expect(reader.getFactsByIds({ corpusId: CORPUS, factIds: ids })).resolves.toHaveLength(150);
  });
});
