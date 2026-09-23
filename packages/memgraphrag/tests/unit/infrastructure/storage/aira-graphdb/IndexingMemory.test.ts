import { Buffer } from 'node:buffer';

import { describe, expect, it, vi } from 'vitest';

import type { Fact } from '../../../../../src/domain/memory/fact.js';
import type { Passage } from '../../../../../src/domain/memory/passage.js';
import type { Schema } from '../../../../../src/domain/memory/schema.js';
import { INDEXING_MEMORY_CONTRACT } from '../../../../../src/domain/storage/indexingMemory.js';
import {
  SCHEMA_CANONICALIZATION_CONTRACT,
  type SchemaCanonicalizationMemoryDelta,
  type SchemaCanonicalizationMergeCreate,
  type SchemaCanonicalizationMergeExisting,
} from '../../../../../src/domain/storage/schemaCanonicalization.js';
import { SnapshotBackedIndexingMemory } from '../../../../../src/infrastructure/storage/SnapshotBackedIndexingMemory.js';
import { AiraGraphDbIndexingMemory } from '../../../../../src/infrastructure/storage/aira-graphdb/AiraGraphDbIndexingMemory.js';
import type { AiraGraphDbRpcClient } from '../../../../../src/infrastructure/storage/aira-graphdb/NativeClient.js';
import { planSchemaCanonicalizationMemoryBatches } from '../../../../../src/infrastructure/storage/aira-graphdb/schemaCanonicalizationMemoryPlanner.js';
import { planMutationChunks } from '../../../../../src/infrastructure/storage/indexingMemoryContract.js';

const NOW = '2026-08-25T00:00:00.000Z';

function protocolInfo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: 'native-method-policy@1',
    generation: 0,
    state: 'idle',
    limits: {
      indexingMemory: {
        ...INDEXING_MEMORY_CONTRACT,
        schemaCanonicalization: SCHEMA_CANONICALIZATION_CONTRACT,
      },
      wal: { mutationRequestIdUniqueness: 'activeTransaction' },
    },
    methods: [
      { name: 'memory_get_schemas_by_ids', classification: 'read', wal: false },
      { name: 'memory_get_active_facts', classification: 'read', wal: false },
      { name: 'memory_activate_facts_by_schema_ids', classification: 'mutation', wal: true },
      { name: 'memory_upsert', classification: 'mutation', wal: true },
      { name: 'upsert_nodes', classification: 'mutation', wal: true },
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

function canonicalProtocolInfo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return protocolInfo({
    limits: {
      indexingMemory: {
        ...INDEXING_MEMORY_CONTRACT,
        schemaCanonicalization: SCHEMA_CANONICALIZATION_CONTRACT,
      },
      wal: { mutationRequestIdUniqueness: 'activeTransaction' },
    },
    ...overrides,
  });
}

function projection(schemaId = 's1'): Record<string, unknown> {
  return {
    schemaId,
    corpusId: 'c1',
    headType: 'person',
    relation: 'authors',
    tailType: 'paper',
    canonicalKey: 'person::authors::paper',
    frequency: 1,
    state: 'pending',
    stabilizationThreshold: 2,
    firstSourceDocumentId: 'd-old',
    contributionPresent: false,
    mergeToken: 'a'.repeat(64),
  };
}

function createIntent(schemaId: string): SchemaCanonicalizationMergeCreate {
  return { mode: 'create', expectedAbsent: true, schema: schema(schemaId) };
}

function mergeIntent(
  schemaId: string,
  additionKind: 'aliases' | 'factIds' | undefined,
  additionCount: number,
): SchemaCanonicalizationMergeExisting {
  return {
    mode: 'merge',
    schemaId,
    expectedMergeToken: 'a'.repeat(64),
    contributionDocumentId: 'd-current',
    frequencyDelta: 1,
    desiredState: 'pending',
    stabilizationThreshold: 2,
    updatedAt: NOW,
    aliasAdditions: additionKind === 'aliases'
      ? Array.from({ length: additionCount }, (_, index) => ({
        label: `${schemaId}-alias-${index}`,
        language: 'en',
        source: 'llm',
        confidence: 0.8,
        isCanonical: false,
      }))
      : [],
    factIdAdditions: additionKind === 'factIds'
      ? Array.from({ length: additionCount }, (_, index) => `${schemaId}-fact-${index}`)
      : [],
  };
}

function maxLengthIds(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const suffix = String(index).padStart(4, '0');
    return `${prefix}${suffix}${'x'.repeat(4096 - prefix.length - suffix.length)}`;
  });
}

function encodedMemoryRequestBytes(params: SchemaCanonicalizationMemoryDelta): number {
  return Buffer.byteLength(JSON.stringify({
    id: Number.MAX_SAFE_INTEGER,
    method: 'memory_upsert',
    params,
  }), 'utf8');
}

function createCanonicalDelta(schemaCount: number): SchemaCanonicalizationMemoryDelta {
  return {
    corpusId: 'c1',
    passages: [passage('p1')],
    facts: [fact('f1')],
    schemaMerges: Array.from({ length: schemaCount }, (_, index) => createIntent(`s${index + 1}`)),
    exportedAt: NOW,
  };
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
      .resolves.toEqual({ mutationCount: 1 });

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

  it('uses the negotiated projection and tagged merge without legacy fallback', async () => {
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === 'protocol_info') return canonicalProtocolInfo();
      if (method === 'memory_get_schemas_by_ids') return [projection()];
      if (method === 'memory_upsert') return null;
      throw new Error(`unexpected ${method}`);
    });
    const memory = await AiraGraphDbIndexingMemory.create({ request } as AiraGraphDbRpcClient);

    await expect(memory.getSchemaCanonicalizationProjection({
      corpusId: 'c1',
      schemaIds: ['s1'],
      projection: 'canonicalization@1',
      contributionDocumentId: 'd-current',
    })).resolves.toEqual([projection()]);
    await expect(memory.upsertSchemaCanonicalizationDelta({
      corpusId: 'c1',
      passages: [],
      facts: [],
      schemaMerges: [{
        mode: 'merge',
        schemaId: 's1',
        expectedMergeToken: 'a'.repeat(64),
        contributionDocumentId: 'd-current',
        frequencyDelta: 1,
        desiredState: 'stable',
        stabilizationThreshold: 2,
        updatedAt: NOW,
        aliasAdditions: [],
        factIdAdditions: [],
      }],
      exportedAt: NOW,
    })).resolves.toEqual({ mutationCount: 1 });

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      'protocol_info',
      'memory_get_schemas_by_ids',
      'memory_upsert',
    ]);
    expect(request.mock.calls[1]?.[1]).toMatchObject({ projection: 'canonicalization@1' });
    expect(request.mock.calls[2]?.[1]).toMatchObject({ schemaMerges: expect.any(Array) });
    expect(request.mock.calls[2]?.[1]).not.toHaveProperty('schemas');
  });

  it('plans and writes a 65-schema document as immutable 32/32/1 memory requests', async () => {
    const delta = createCanonicalDelta(65);
    let upsertCalls = 0;
    const { client, request } = clientWith(async (method) => {
      if (method !== 'memory_upsert') throw new Error(`unexpected ${method}`);
      upsertCalls += 1;
      if (upsertCalls === 1) {
        const lateIntent = delta.schemaMerges[32];
        if (lateIntent?.mode === 'create') Object.assign(lateIntent.schema, { schemaId: 'mutated-after-plan' });
      }
      return null;
    });
    const memory = await AiraGraphDbIndexingMemory.create(client);
    memory.preflightSchemaCanonicalizationDelta(delta);
    expect(request.mock.calls.filter(([method]) => method === 'memory_upsert')).toHaveLength(0);

    await expect(memory.upsertSchemaCanonicalizationDelta(delta))
      .resolves.toEqual({ mutationCount: 3 });

    const batches = request.mock.calls
      .filter(([method]) => method === 'memory_upsert')
      .map(([, params]) => params as SchemaCanonicalizationMemoryDelta);
    expect(batches.map((batch) => batch.schemaMerges.length)).toEqual([32, 32, 1]);
    expect(batches.map((batch) => batch.passages.length)).toEqual([1, 0, 0]);
    expect(batches.map((batch) => batch.facts.length)).toEqual([1, 0, 0]);
    expect(batches.flatMap((batch) => batch.schemaMerges.map((intent) => (
      intent.mode === 'create' ? intent.schema.schemaId : intent.schemaId
    )))).toEqual(Array.from({ length: 65 }, (_, index) => `s${index + 1}`));
    expect(Object.isFrozen(batches[0])).toBe(true);
    expect(Object.isFrozen(batches[0]?.schemaMerges)).toBe(true);
  });

  it('splits exactly 33 schema merges into ordered 32/1 requests', async () => {
    const { client, request } = clientWith((method) => {
      if (method !== 'memory_upsert') throw new Error(`unexpected ${method}`);
      return null;
    });
    const memory = await AiraGraphDbIndexingMemory.create(client);

    await expect(memory.upsertSchemaCanonicalizationDelta(createCanonicalDelta(33)))
      .resolves.toEqual({ mutationCount: 2 });

    const batches = request.mock.calls
      .filter(([method]) => method === 'memory_upsert')
      .map(([, params]) => params as SchemaCanonicalizationMemoryDelta);
    expect(batches.map((batch) => batch.schemaMerges.length)).toEqual([32, 1]);
    expect(batches.map((batch) => batch.passages.length)).toEqual([1, 0]);
    expect(batches.map((batch) => batch.facts.length)).toEqual([1, 0]);
  });

  it('rejects an aggregate 4097-schema memory plan before exposing chunks', () => {
    expect(() => planSchemaCanonicalizationMemoryBatches(
      createCanonicalDelta(INDEXING_MEMORY_CONTRACT.maxSchemaIds + 1),
      SCHEMA_CANONICALIZATION_CONTRACT,
    )).toThrow('schemaMerges exceed the document schema bound');
  });

  it.each([
    ['create', createIntent('s1')],
    ['merge', mergeIntent('s1', undefined, 0)],
  ] as const)('rejects a cross-batch duplicate schema ID in the final %s intent', (_mode, duplicate) => {
    const base = createCanonicalDelta(32);
    const delta: SchemaCanonicalizationMemoryDelta = {
      ...base,
      schemaMerges: [...base.schemaMerges, duplicate],
    };

    expect(() => planSchemaCanonicalizationMemoryBatches(delta, SCHEMA_CANONICALIZATION_CONTRACT))
      .toThrow('schemaMerges must not contain duplicate schemaId values');
  });

  it.each(['aliases', 'factIds'] as const)(
    'splits aggregate %s additions at the negotiated per-request bound',
    async (additionKind) => {
      const { client, request } = clientWith((method) => {
        if (method !== 'memory_upsert') throw new Error(`unexpected ${method}`);
        return null;
      });
      const memory = await AiraGraphDbIndexingMemory.create(client);
      const delta: SchemaCanonicalizationMemoryDelta = {
        corpusId: 'c1',
        passages: [],
        facts: [],
        schemaMerges: [
          mergeIntent('s1', additionKind, 3000),
          mergeIntent('s2', additionKind, 3000),
        ],
        exportedAt: NOW,
      };

      await expect(memory.upsertSchemaCanonicalizationDelta(delta))
        .resolves.toEqual({ mutationCount: 2 });

      const batches = request.mock.calls
        .filter(([method]) => method === 'memory_upsert')
        .map(([, params]) => params as SchemaCanonicalizationMemoryDelta);
      expect(batches.map((batch) => batch.schemaMerges.length)).toEqual([1, 1]);
      const additionCounts = batches.map((batch) => {
        const intent = batch.schemaMerges[0];
        return intent?.mode === 'merge'
          ? additionKind === 'aliases'
            ? intent.aliasAdditions.length
            : intent.factIdAdditions.length
          : -1;
      });
      expect(additionCounts).toEqual([3000, 3000]);
    },
  );

  it('splits just over 64 MiB of schema payload into two individually bounded requests', () => {
    const count = 4074;
    const firstSchema: Schema = {
      ...schema('s1'),
      aliases: maxLengthIds('alias-', count).map((label, index) => ({
        label,
        language: 'en',
        source: 'manual',
        confidence: 0.8,
        isCanonical: index === 0,
      })),
      factIds: maxLengthIds('fact-a-', count),
      sourceDocumentIds: maxLengthIds('document-a-', count),
    };
    const secondSchema: Schema = {
      ...schema('s2'),
      factIds: maxLengthIds('fact-b-', count),
    };
    const source = createCanonicalDelta(0);
    const delta: SchemaCanonicalizationMemoryDelta = {
      ...source,
      schemaMerges: [
        { mode: 'create', expectedAbsent: true, schema: firstSchema },
        { mode: 'create', expectedAbsent: true, schema: secondSchema },
      ],
    };
    const firstOnly: SchemaCanonicalizationMemoryDelta = {
      ...delta,
      schemaMerges: [delta.schemaMerges[0]!],
    };
    const secondOnly: SchemaCanonicalizationMemoryDelta = {
      ...delta,
      passages: [],
      facts: [],
      schemaMerges: [delta.schemaMerges[1]!],
    };

    const firstBytes = encodedMemoryRequestBytes(firstOnly);
    const secondBytes = encodedMemoryRequestBytes(secondOnly);
    const combinedBytes = encodedMemoryRequestBytes(delta);
    expect(firstBytes).toBeLessThan(INDEXING_MEMORY_CONTRACT.maxRequestBytes);
    expect(secondBytes).toBeLessThan(INDEXING_MEMORY_CONTRACT.maxRequestBytes);
    expect(combinedBytes).toBeGreaterThan(INDEXING_MEMORY_CONTRACT.maxRequestBytes);
    expect(combinedBytes).toBeLessThan(65 * 1024 * 1024);

    const planned = planSchemaCanonicalizationMemoryBatches(delta, SCHEMA_CANONICALIZATION_CONTRACT);
    const plannedBytes = planned.map(encodedMemoryRequestBytes);
    expect(planned).toHaveLength(2);
    expect(planned.map((batch) => batch.schemaMerges.length)).toEqual([1, 1]);
    expect(plannedBytes.every((bytes) => bytes <= INDEXING_MEMORY_CONTRACT.maxRequestBytes)).toBe(true);
  }, 30_000);

  it('rejects a malformed later merge before sending any memory batch', async () => {
    const valid = createCanonicalDelta(33);
    const malformed = createIntent('') as unknown as SchemaCanonicalizationMergeCreate;
    const delta: SchemaCanonicalizationMemoryDelta = {
      ...valid,
      schemaMerges: [...valid.schemaMerges.slice(0, 32), malformed],
    };
    const { client, request } = clientWith((method) => {
      if (method === 'memory_upsert') return null;
      throw new Error(`unexpected ${method}`);
    });
    const memory = await AiraGraphDbIndexingMemory.create(client);

    await expect(memory.upsertSchemaCanonicalizationDelta(delta)).rejects.toThrow();
    expect(request.mock.calls.filter(([method]) => method === 'memory_upsert')).toHaveLength(0);
  });

  it('stops after a later memory batch fails without inline retry', async () => {
    let upsertCalls = 0;
    const { client, request } = clientWith((method) => {
      if (method !== 'memory_upsert') throw new Error(`unexpected ${method}`);
      upsertCalls += 1;
      if (upsertCalls === 2) throw new Error('batch 2 failed');
      return null;
    });
    const memory = await AiraGraphDbIndexingMemory.create(client);

    await expect(memory.upsertSchemaCanonicalizationDelta(createCanonicalDelta(65)))
      .rejects.toThrow('batch 2 failed');
    expect(request.mock.calls.filter(([method]) => method === 'memory_upsert')).toHaveLength(2);
  });

  it('rejects a partial canonical capability at protocol startup', async () => {
    const partial = {
      ...SCHEMA_CANONICALIZATION_CONTRACT,
      maxGraphHydrations: 31,
    };
    const client = {
      request: vi.fn().mockResolvedValue(canonicalProtocolInfo({
        limits: {
          indexingMemory: {
            ...INDEXING_MEMORY_CONTRACT,
            schemaCanonicalization: partial,
          },
          wal: { mutationRequestIdUniqueness: 'activeTransaction' },
        },
      })),
    } as AiraGraphDbRpcClient;
    await expect(AiraGraphDbIndexingMemory.create(client)).rejects.toThrow();
  });

  it('fails closed when the native capability is absent', async () => {
    const client = {
      request: vi.fn().mockResolvedValue(protocolInfo({
        limits: {
          indexingMemory: { ...INDEXING_MEMORY_CONTRACT },
          wal: { mutationRequestIdUniqueness: 'activeTransaction' },
        },
      })),
    } as AiraGraphDbRpcClient;
    await expect(AiraGraphDbIndexingMemory.create(client))
      .rejects.toThrow('capability is missing');
  });

  it.each([
    'memory_get_schemas_by_ids',
    'memory_get_active_facts',
  ] as const)('preserves a trusted native error for %s without inferring or rewriting it', async (method) => {
    const secret = 'request-secret-must-not-cross-boundary';
    const nativeError = Object.assign(
      new Error(`${method}: bounded indexing response exceeds its byte limit`),
      {
        code: 'REQUEST_EXECUTION_FAILED',
        failureClass: 'CLIENT_INPUT',
        rpcMethod: method,
      },
    );
    // The native client constructs this already-prefixed message before the
    // stack can be materialized; the consumer must preserve it verbatim.
    void nativeError.stack;
    const { client, request } = clientWith((actualMethod) => {
      expect(actualMethod).toBe(method);
      throw nativeError;
    });
    const memory = await AiraGraphDbIndexingMemory.create(client);
    const operation = method === 'memory_get_schemas_by_ids'
      ? memory.getSchemasByIds({ corpusId: 'c1', schemaIds: [secret] })
      : memory.getActiveFacts({ corpusId: 'c1', limit: 1 });

    const rejected = await operation.catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(Error);
    expect(rejected).toBe(nativeError);
    const indexedError = rejected as Error & {
      code?: string;
      failureClass?: string;
      rpcMethod?: string;
    };
    expect(indexedError.message).toBe(`${method}: bounded indexing response exceeds its byte limit`);
    expect(indexedError.stack?.split('\n')[0]).toContain(indexedError.message);
    expect(indexedError).toMatchObject({
      code: 'REQUEST_EXECUTION_FAILED',
      failureClass: 'CLIENT_INPUT',
      rpcMethod: method,
    });
    expect(JSON.stringify(indexedError)).not.toContain(secret);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('does not infer an indexing method for a transport or protocol error', async () => {
    const poison = new Error('aira-graphdb response envelope or request ID is invalid');
    const { client, request } = clientWith(() => {
      throw poison;
    });
    const memory = await AiraGraphDbIndexingMemory.create(client);

    const rejected = await memory.getSchemasByIds({ corpusId: 'c1', schemaIds: ['s1'] })
      .catch((error: unknown) => error);
    expect(rejected).toBe(poison);
    expect(rejected).not.toHaveProperty('rpcMethod');
    expect((rejected as Error).message).toBe('aira-graphdb response envelope or request ID is invalid');
    expect(request).toHaveBeenCalledTimes(2);
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
      protocolInfo({
        methods: protocolInfo().methods.filter((method) => method.name !== 'upsert_nodes'),
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
    await expect(memory.upsertDelta(delta)).resolves.toEqual({ mutationCount: 2 });

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
