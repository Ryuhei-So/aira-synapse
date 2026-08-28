import { describe, expect, it, vi } from 'vitest';

import type { Fact } from '../../../../../src/domain/memory/fact.js';
import type { Passage } from '../../../../../src/domain/memory/passage.js';
import type { Schema } from '../../../../../src/domain/memory/schema.js';
import { INDEXING_MEMORY_CONTRACT } from '../../../../../src/domain/storage/indexingMemory.js';
import { SnapshotBackedIndexingMemory } from '../../../../../src/infrastructure/storage/SnapshotBackedIndexingMemory.js';
import { AiraGraphDbIndexingMemory } from '../../../../../src/infrastructure/storage/aira-graphdb/AiraGraphDbIndexingMemory.js';
import type { AiraGraphDbRpcClient } from '../../../../../src/infrastructure/storage/aira-graphdb/NativeClient.js';
import { planMutationChunks } from '../../../../../src/infrastructure/storage/indexingMemoryContract.js';

const NOW = '2026-08-25T00:00:00.000Z';

function protocolInfo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: 'native-method-policy@1',
    generation: 0,
    state: 'idle',
    limits: {
      indexingMemory: { ...INDEXING_MEMORY_CONTRACT },
      wal: { mutationRequestIdUniqueness: 'activeTransaction' },
    },
    methods: [
      { name: 'memory_get_schemas_by_ids', classification: 'read', wal: false },
      { name: 'memory_get_active_facts', classification: 'read', wal: false },
      { name: 'memory_activate_facts_by_schema_ids', classification: 'mutation', wal: true },
      { name: 'memory_upsert', classification: 'mutation', wal: true },
    ],
    ...overrides,
  };
}

function schema(schemaId: string, corpusId = 'c1'): Schema {
  return {
    schemaId,
    corpusId,
    headType: 'person',
    relation: 'authors',
    tailType: 'paper',
    canonicalKey: 'person::authors::paper',
    aliases: [],
    frequency: 2,
    state: 'stable',
    stabilizationThreshold: 2,
    factIds: [],
    sourceDocumentIds: ['d1'],
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function fact(factId: string, corpusId = 'c1'): Fact {
  return {
    factId,
    corpusId,
    schemaId: 's1',
    headEntity: 'Alice',
    headType: 'person',
    relation: 'authors',
    tailEntity: 'Paper',
    tailType: 'paper',
    state: 'active',
    passageIds: ['p1'],
    sourceDocumentIds: ['d1'],
    confidence: 0.9,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function passage(passageId: string, corpusId = 'c1'): Passage {
  return {
    passageId,
    corpusId,
    text: 'x',
    normalizedText: 'x',
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

function clientWith(
  handler: (method: string, params: unknown) => unknown | Promise<unknown>,
): { client: AiraGraphDbRpcClient; request: ReturnType<typeof vi.fn> } {
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === 'protocol_info') return protocolInfo();
    return handler(method, params);
  });
  return { client: { request } as AiraGraphDbRpcClient, request };
}

describe('AiraGraphDbIndexingMemory strict bounded contract', () => {
  it('validates the versioned capability and uses only bounded indexing methods', async () => {
    const { client, request } = clientWith((method) => {
      if (method === 'memory_get_schemas_by_ids') return [schema('s2'), schema('s1')];
      if (method === 'memory_get_active_facts') return [fact('f1')];
      if (method === 'memory_activate_facts_by_schema_ids') return { activated: 1 };
      if (method === 'memory_upsert') return null;
      throw new Error(`unexpected ${method}`);
    });
    const memory = await AiraGraphDbIndexingMemory.create(client);

    await expect(memory.getSchemasByIds({ corpusId: 'c1', schemaIds: ['s2', 'missing', 's1'] }))
      .resolves.toEqual([schema('s2'), schema('s1')]);
    await expect(memory.getActiveFacts({ corpusId: 'c1', limit: 1 }))
      .resolves.toEqual([fact('f1')]);
    await expect(memory.activateFactsBySchemaIds({ corpusId: 'c1', schemaIds: ['s1'], updatedAt: NOW }))
      .resolves.toBe(1);
    await expect(memory.upsertDelta({ corpusId: 'c1', passages: [], facts: [], schemas: [], exportedAt: NOW }))
      .resolves.toBeUndefined();

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      'protocol_info',
      'memory_get_schemas_by_ids',
      'memory_get_active_facts',
      'memory_activate_facts_by_schema_ids',
      'memory_upsert',
    ]);
    expect(request.mock.calls.slice(1).every((call) => call[2]?.maxRequestBytes === 64 * 1024 * 1024
      && call[2]?.maxResponseBytes === 8 * 1024 * 1024)).toBe(true);
  });

  it('fails startup for cap, method, state, or request-ID-scope drift', async () => {
    const invalid = [
      protocolInfo({ state: 'recoveryPending' }),
      protocolInfo({
        limits: {
          indexingMemory: { ...INDEXING_MEMORY_CONTRACT, maxResponseBytes: 8 * 1024 * 1024 + 1 },
          wal: { mutationRequestIdUniqueness: 'connection' },
        },
      }),
      protocolInfo({
        methods: [
          { name: 'memory_get_schemas_by_ids', classification: 'read', wal: false },
          { name: 'memory_get_schemas_by_ids', classification: 'read', wal: false },
        ],
      }),
    ];

    for (const response of invalid) {
      const client = { request: vi.fn().mockResolvedValue(response) } as AiraGraphDbRpcClient;
      await expect(AiraGraphDbIndexingMemory.create(client)).rejects.toThrow();
    }
  });

  it('rejects duplicate and UTF-8-overlong IDs before issuing a read', async () => {
    const { client, request } = clientWith(() => []);
    const memory = await AiraGraphDbIndexingMemory.create(client);

    await expect(memory.getSchemasByIds({ corpusId: 'c1', schemaIds: ['same', 'same'] }))
      .rejects.toThrow('duplicate');
    await expect(memory.getSchemasByIds({
      corpusId: 'c1',
      schemaIds: ['界'.repeat(Math.floor(INDEXING_MEMORY_CONTRACT.maxDomainIdBytes / 3) + 1)],
    })).rejects.toThrow('UTF-8 bytes');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('accepts exact count/UTF-8 boundaries and rejects max plus one before RPC', async () => {
    const { client, request } = clientWith((method) => {
      if (method === 'memory_get_schemas_by_ids' || method === 'memory_get_active_facts') return [];
      if (method === 'memory_activate_facts_by_schema_ids') return { activated: 0 };
      throw new Error(`unexpected ${method}`);
    });
    const memory = await AiraGraphDbIndexingMemory.create(client);
    const exactDomainId = `${'界'.repeat(1365)}x`;
    const exactCorpusId = `${'界'.repeat(341)}x`;
    const schemaIds = Array.from(
      { length: INDEXING_MEMORY_CONTRACT.maxSchemaIds },
      (_, index) => `s${index}`,
    );

    await expect(memory.getSchemasByIds({ corpusId: 'c1', schemaIds: [exactDomainId] }))
      .resolves.toEqual([]);
    await expect(memory.getSchemasByIds({ corpusId: exactCorpusId, schemaIds: [] }))
      .resolves.toEqual([]);
    await expect(memory.getSchemasByIds({ corpusId: 'c1', schemaIds }))
      .resolves.toEqual([]);
    await expect(memory.getActiveFacts({ corpusId: 'c1', limit: INDEXING_MEMORY_CONTRACT.maxActiveFacts }))
      .resolves.toEqual([]);
    await expect(memory.activateFactsBySchemaIds({
      corpusId: 'c1',
      schemaIds: ['s1'],
      updatedAt: 'x'.repeat(INDEXING_MEMORY_CONTRACT.maxUpdatedAtBytes),
    })).resolves.toBe(0);
    await expect(memory.activateFactsBySchemaIds({
      corpusId: 'c1',
      schemaIds,
      updatedAt: NOW,
    })).resolves.toBe(0);

    await expect(memory.getSchemasByIds({ corpusId: 'c1', schemaIds: [`${exactDomainId}x`] }))
      .rejects.toThrow('UTF-8 bytes');
    await expect(memory.getSchemasByIds({ corpusId: `${exactCorpusId}x`, schemaIds: [] }))
      .rejects.toThrow('UTF-8 bytes');
    await expect(memory.getSchemasByIds({ corpusId: 'c1', schemaIds: [...schemaIds, 'overflow'] }))
      .rejects.toThrow('must not exceed');
    await expect(memory.getActiveFacts({ corpusId: 'c1', limit: INDEXING_MEMORY_CONTRACT.maxActiveFacts + 1 }))
      .rejects.toThrow('must not exceed');
    await expect(memory.activateFactsBySchemaIds({
      corpusId: 'c1',
      schemaIds: ['s1'],
      updatedAt: 'x'.repeat(INDEXING_MEMORY_CONTRACT.maxUpdatedAtBytes + 1),
    })).rejects.toThrow('UTF-8 bytes');
    await expect(memory.activateFactsBySchemaIds({
      corpusId: 'c1',
      schemaIds: [...schemaIds, 'overflow'],
      updatedAt: NOW,
    })).rejects.toThrow('must not exceed');
    expect(request).toHaveBeenCalledTimes(7);
  });

  it('preflights the complete mutation plan and wire cap without issuing an RPC', async () => {
    const { client, request } = clientWith(() => null);
    const memory = await AiraGraphDbIndexingMemory.create(client);
    const validDelta = { corpusId: 'c1', passages: [], facts: [], schemas: [], exportedAt: NOW };

    expect(() => memory.preflightMutation({
      delta: validDelta,
      activation: { corpusId: 'c1', schemaIds: ['s1'], updatedAt: NOW },
    })).not.toThrow();
    expect(() => memory.preflightMutation({
      delta: { ...validDelta, unsupported: true } as never,
    })).toThrow('unsupported fields');
    expect(() => memory.preflightMutation({
      delta: validDelta,
      activation: { corpusId: 'other', schemaIds: ['s1'], updatedAt: NOW },
    })).toThrow('must match');
    const baseSizedDelta = {
      ...validDelta,
      schemas: [{ ...schema('s1'), headType: '' }],
    };
    const baseBytes = Buffer.byteLength(JSON.stringify({
      id: Number.MAX_SAFE_INTEGER,
      method: 'memory_upsert',
      params: baseSizedDelta,
    }), 'utf8');
    const exactHeadType = 'x'.repeat(INDEXING_MEMORY_CONTRACT.maxRequestBytes - baseBytes);
    const exactSizedDelta = {
      ...baseSizedDelta,
      schemas: [{ ...baseSizedDelta.schemas[0]!, headType: exactHeadType }],
    };
    const oversizedDelta = {
      ...exactSizedDelta,
      schemas: [{ ...exactSizedDelta.schemas[0]!, headType: `${exactHeadType}x` }],
    };
    expect(() => memory.preflightMutation({ delta: exactSizedDelta })).not.toThrow();
    expect(() => memory.preflightMutation({ delta: oversizedDelta })).toThrow('request exceeds');

    const save = vi.fn().mockResolvedValue(undefined);
    const compatibilityMemory = new SnapshotBackedIndexingMemory({ save } as never);
    await expect(compatibilityMemory.upsertDelta(oversizedDelta)).rejects.toThrow('request exceeds');
    expect(save).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['schemas', (index: number) => schema(`s${index}`)],
    ['facts', (index: number) => fact(`f${index}`)],
    ['passages', (index: number) => passage(`p${index}`)],
  ] as const)('accepts exact and max-plus-one document delta counts for %s', async (section, item) => {
    const { client, request } = clientWith(() => null);
    const memory = await AiraGraphDbIndexingMemory.create(client);
    const validDelta = { corpusId: 'c1', passages: [], facts: [], schemas: [], exportedAt: NOW };
    const exact = Array.from(
      { length: INDEXING_MEMORY_CONTRACT.maxDeltaItemsPerSection },
      (_, index) => item(index),
    );

    expect(() => memory.preflightMutation({
      delta: { ...validDelta, [section]: exact } as never,
    })).not.toThrow();
    expect(() => memory.preflightMutation({
      delta: { ...validDelta, [section]: [...exact, item(exact.length)] } as never,
    })).not.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('preflights and sends an oversized document as bounded ordered deltas', async () => {
    const { client, request } = clientWith((method) => {
      if (method === 'memory_upsert') return null;
      throw new Error(`unexpected ${method}`);
    });
    const memory = await AiraGraphDbIndexingMemory.create(client);
    const facts = Array.from(
      { length: INDEXING_MEMORY_CONTRACT.maxDeltaItemsPerSection + 1 },
      (_, index) => fact(`f${index}`),
    );
    const delta = {
      corpusId: 'c1', passages: [passage('p1')], facts,
      schemas: [schema('s1')], exportedAt: NOW,
    };

    expect(() => memory.preflightMutation({ delta })).not.toThrow();
    await expect(memory.upsertDelta(delta)).resolves.toBeUndefined();

    const mutations = request.mock.calls.filter(([method]) => method === 'memory_upsert');
    expect(mutations).toHaveLength(2);
    expect(mutations.map(([, params]) => (params as typeof delta).facts.length))
      .toEqual([INDEXING_MEMORY_CONTRACT.maxDeltaItemsPerSection, 1]);
    expect(mutations.flatMap(([, params]) => (params as typeof delta).facts.map(({ factId }) => factId)))
      .toEqual(facts.map(({ factId }) => factId));
    expect((mutations[0]![1] as typeof delta).passages).toEqual(delta.passages);
    expect((mutations[0]![1] as typeof delta).schemas).toEqual(delta.schemas);
    expect((mutations[1]![1] as typeof delta).passages).toEqual([]);
    expect((mutations[1]![1] as typeof delta).schemas).toEqual([]);
    expect(mutations.every((call) => call[2]?.maxRequestBytes === INDEXING_MEMORY_CONTRACT.maxRequestBytes
      && call[2]?.maxResponseBytes === INDEXING_MEMORY_CONTRACT.maxResponseBytes)).toBe(true);
  });

  it('propagates a later chunk failure without fallback or a further mutation', async () => {
    let upserts = 0;
    const { client, request } = clientWith((method) => {
      if (method !== 'memory_upsert') throw new Error(`unexpected ${method}`);
      upserts += 1;
      if (upserts === 2) throw new Error('second delta WAL failed');
      return null;
    });
    const memory = await AiraGraphDbIndexingMemory.create(client);
    const delta = {
      corpusId: 'c1', passages: [],
      facts: Array.from(
        { length: INDEXING_MEMORY_CONTRACT.maxDeltaItemsPerSection + 1 },
        (_, index) => fact(`f${index}`),
      ),
      schemas: [], exportedAt: NOW,
    };

    await expect(memory.upsertDelta(delta)).rejects.toThrow('second delta WAL failed');
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      'protocol_info', 'memory_upsert', 'memory_upsert',
    ]);
  });

  it('rejects duplicate IDs across a chunk boundary before the first mutation', async () => {
    const { client, request } = clientWith(() => null);
    const memory = await AiraGraphDbIndexingMemory.create(client);
    const facts = Array.from(
      { length: INDEXING_MEMORY_CONTRACT.maxDeltaItemsPerSection + 1 },
      (_, index) => fact(`f${index}`),
    );
    facts[facts.length - 1] = fact('f0');
    const delta = {
      corpusId: 'c1', passages: [], facts, schemas: [], exportedAt: NOW,
    };

    expect(() => memory.preflightMutation({ delta })).toThrow('duplicate factId');
    await expect(memory.upsertDelta(delta)).rejects.toThrow('duplicate factId');
    expect(request.mock.calls.map(([method]) => method)).toEqual(['protocol_info']);
  });

  it('plans uneven and empty deltas completely before mutation and activates last', () => {
    const delta = {
      corpusId: 'c1',
      passages: [passage('p0'), passage('p1'), passage('p2')],
      facts: [fact('f0'), fact('f1'), fact('f2'), fact('f3'), fact('f4')],
      schemas: [schema('s1')],
      exportedAt: NOW,
    };
    const activation = { corpusId: 'c1', schemaIds: ['s1'], updatedAt: NOW };
    const plans = planMutationChunks({ delta, activation }, 2);

    expect(plans).toHaveLength(3);
    expect(plans.flatMap(({ delta: chunk }) => chunk.passages.map(({ passageId }) => passageId)))
      .toEqual(delta.passages.map(({ passageId }) => passageId));
    expect(plans.flatMap(({ delta: chunk }) => chunk.facts.map(({ factId }) => factId)))
      .toEqual(delta.facts.map(({ factId }) => factId));
    expect(plans.flatMap(({ delta: chunk }) => chunk.schemas.map(({ schemaId }) => schemaId)))
      .toEqual(delta.schemas.map(({ schemaId }) => schemaId));
    expect(plans.map((plan) => plan.activation)).toEqual([undefined, undefined, activation]);

    const empty = planMutationChunks({
      delta: { corpusId: 'c1', passages: [], facts: [], schemas: [], exportedAt: NOW },
    }, 2);
    expect(empty).toHaveLength(1);
    expect(empty[0]!.delta).toEqual({
      corpusId: 'c1', passages: [], facts: [], schemas: [], exportedAt: NOW,
    });
  });

  it('rejects a byte-oversized later chunk before exposing any mutation plan', () => {
    const oversized = schema('s1');
    const delta = {
      corpusId: 'c1', passages: [], facts: [],
      schemas: [schema('s0'), {
        ...oversized,
        schemaId: 's1',
        headType: 'x'.repeat(INDEXING_MEMORY_CONTRACT.maxRequestBytes),
      }],
      exportedAt: NOW,
    };

    expect(() => planMutationChunks({ delta }, 1)).toThrow('request exceeds');
  });

  it.each([
    ['wrong corpus', [schema('s1', 'other')]],
    ['unrequested ID', [schema('other')]],
    ['duplicate ID', [schema('s1'), schema('s1')]],
    ['wrong order', [schema('s2'), schema('s1')]],
    ['malformed shape', [{ schemaId: 's1', corpusId: 'c1' }]],
    ['unknown domain field', [{ ...schema('s1'), futureField: true }]],
    ['invalid nested enum', [{
      ...schema('s1'),
      aliases: [{ label: 'Author', language: 'future', source: 'llm', confidence: 1, isCanonical: true }],
    }]],
  ])('rejects a %s schema response without fallback', async (_name, response) => {
    const { client, request } = clientWith(() => response);
    const memory = await AiraGraphDbIndexingMemory.create(client);
    await expect(memory.getSchemasByIds({ corpusId: 'c1', schemaIds: ['s1', 's2'] }))
      .rejects.toThrow();
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      'protocol_info',
      'memory_get_schemas_by_ids',
    ]);
  });

  it('rejects non-active, duplicate, wrong-corpus, and oversized active fact results', async () => {
    const responses: unknown[] = [
      [{ ...fact('f1'), state: 'inactive' }],
      [fact('f1'), fact('f1')],
      [fact('f1', 'other')],
      [fact('f1'), fact('f2')],
    ];
    for (const response of responses) {
      const { client } = clientWith(() => response);
      const memory = await AiraGraphDbIndexingMemory.create(client);
      await expect(memory.getActiveFacts({ corpusId: 'c1', limit: 1 })).rejects.toThrow();
    }
  });

  it('rejects malformed mutation results and wrong-corpus deltas without retry or fallback', async () => {
    const { client, request } = clientWith((method) => (
      method === 'memory_activate_facts_by_schema_ids' ? { activated: 1, extra: true } : { saved: true }
    ));
    const memory = await AiraGraphDbIndexingMemory.create(client);

    await expect(memory.activateFactsBySchemaIds({ corpusId: 'c1', schemaIds: ['s1'], updatedAt: NOW }))
      .rejects.toThrow('only activated');
    await expect(memory.upsertDelta({
      corpusId: 'c1',
      passages: [],
      facts: [],
      schemas: [schema('s1', 'other')],
      exportedAt: NOW,
    })).rejects.toThrow('requested corpus');
    await expect(memory.upsertDelta({
      corpusId: 'c1',
      passages: [],
      facts: [],
      schemas: [{ schemaId: 's1', corpusId: 'c1' } as never],
      exportedAt: NOW,
    })).rejects.toThrow('headType');
    await expect(memory.upsertDelta({ corpusId: 'c1', passages: [], facts: [], schemas: [], exportedAt: NOW }))
      .rejects.toThrow('must be null');

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      'protocol_info',
      'memory_activate_facts_by_schema_ids',
      'memory_upsert',
    ]);
  });
});
