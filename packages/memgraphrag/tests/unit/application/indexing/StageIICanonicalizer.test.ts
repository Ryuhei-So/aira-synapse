import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../../src/infrastructure/storage/migrate.js';
import { SQLiteMemoryStore } from '../../../../src/infrastructure/storage/SQLiteMemoryStore.js';
import { SnapshotBackedIndexingMemory } from '../../../../src/infrastructure/storage/SnapshotBackedIndexingMemory.js';
import type { CompositeExtractionRecord, ISchemaCanonicalizer } from '../../../../src/domain/agent/index.js';
import { createNotImplementedStub } from '../../../setup/testDoubles.js';
import { StageIICanonicalizer } from '../../../../src/application/indexing/StageIICanonicalizer.js';
import {
  SCHEMA_CANONICALIZATION_CONTRACT,
  type ISchemaCanonicalizationMemory,
  type SchemaCanonicalizationProjection,
  type SchemaCanonicalizationProjectionRequest,
} from '../../../../src/domain/storage/schemaCanonicalization.js';
import { computeCanonicalKey } from '../../../../src/domain/memory/schema.js';
import type { IIndexingMemory } from '../../../../src/domain/storage/indexingMemory.js';
import { validateSchemaCanonicalizationProjectionRequest } from '../../../../src/infrastructure/storage/schemaCanonicalizationContract.js';

function createRecord(): CompositeExtractionRecord {
  return {
    chunk: {
      corpusId: 'corpus-1',
      documentId: 'doc-1',
      chunkId: 'doc-1:0',
      text: 'Alice works at ACME',
      normalizedText: 'alice works at acme',
      language: 'en',
      metadata: {
        documentId: 'doc-1',
        title: 'Doc',
        sourceUrl: 'https://example.com',
        language: 'en',
        sectionPath: ['Intro'],
        chunkId: 'doc-1:0',
        chunkIndex: 0,
        offsetStart: 0,
        offsetEnd: 10,
      },
    },
    candidateSchemas: [{
      headType: 'Researcher',
      relation: 'authors',
      tailType: 'Paper',
      canonicalKey: 'researcher::authors::paper',
      aliases: [],
      confidence: 0.8,
    }],
    candidateFacts: [],
    sourcePassage: {
      passageId: 'p-1',
      corpusId: 'corpus-1',
      text: 'Alice works at ACME',
      normalizedText: 'alice works at acme',
      metadata: {
        documentId: 'doc-1',
        title: 'Doc',
        sourceUrl: 'https://example.com',
        language: 'en',
        sectionPath: ['Intro'],
        chunkId: 'doc-1:0',
        chunkIndex: 0,
        offsetStart: 0,
        offsetEnd: 10,
      },
      factIds: ['f-1'],
      entityMentions: ['Alice'],
      qualityFlags: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    rawEntities: ['Alice'],
  };
}

function candidateSchema(schemaId = 'schema:person::authors::paper', alias = 'authors') {
  return {
    schemaId,
    corpusId: 'corpus-1',
    headType: 'Person',
    relation: 'authors',
    tailType: 'Paper',
    canonicalKey: 'person::authors::paper',
    aliases: [{
      label: alias,
      language: 'en' as const,
      source: 'extractor',
      confidence: 0.8,
      isCanonical: false,
    }],
    frequency: 1,
    state: 'pending' as const,
    stabilizationThreshold: 2,
    factIds: [],
    sourceDocumentIds: ['doc-1'],
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function candidateSchemas(count: number): ReturnType<typeof candidateSchema>[] {
  return Array.from({ length: count }, (_, index) => {
    const ordinal = index + 1;
    const headType = `Person ${ordinal}`;
    const relation = `authored ${ordinal}`;
    const tailType = `Paper ${ordinal}`;
    return {
      ...candidateSchema(`schema:${ordinal}`, `alias-${ordinal}`),
      headType,
      relation,
      tailType,
      canonicalKey: computeCanonicalKey(headType, relation, tailType),
    };
  });
}

function projection(overrides: Partial<SchemaCanonicalizationProjection> = {}): SchemaCanonicalizationProjection {
  return {
    schemaId: 'schema:person::authors::paper',
    corpusId: 'corpus-1',
    headType: 'Person',
    relation: 'authors',
    tailType: 'Paper',
    canonicalKey: 'person::authors::paper',
    frequency: 1,
    state: 'pending',
    stabilizationThreshold: 2,
    firstSourceDocumentId: 'doc-old',
    contributionPresent: false,
    mergeToken: 'a'.repeat(64),
    ...overrides,
  };
}

function projectionForCandidate(schema: ReturnType<typeof candidateSchema>): SchemaCanonicalizationProjection {
  return projection({
    schemaId: schema.schemaId,
    corpusId: schema.corpusId,
    headType: schema.headType,
    relation: schema.relation,
    tailType: schema.tailType,
    canonicalKey: schema.canonicalKey,
  });
}

function canonicalMemory(
  projections: readonly SchemaCanonicalizationProjection[],
): IIndexingMemory & ISchemaCanonicalizationMemory {
  const getSchemaCanonicalizationProjection = vi.fn(async (request: SchemaCanonicalizationProjectionRequest) => {
    validateSchemaCanonicalizationProjectionRequest(request, SCHEMA_CANONICALIZATION_CONTRACT);
    const requestedIds = new Set(request.schemaIds);
    return projections.filter((item) => requestedIds.has(item.schemaId));
  });

  return {
    getSchemasByIds: vi.fn().mockResolvedValue([]),
    getActiveFacts: vi.fn().mockResolvedValue([]),
    preflightMutation: vi.fn(),
    activateFactsBySchemaIds: vi.fn().mockResolvedValue(0),
    upsertDelta: vi.fn().mockResolvedValue({ mutationCount: 1 }),
    schemaCanonicalizationCapability: SCHEMA_CANONICALIZATION_CONTRACT,
    preflightSchemaCanonicalizationDelta: vi.fn(),
    getSchemaCanonicalizationProjection,
    upsertSchemaCanonicalizationDelta: vi.fn().mockResolvedValue({ mutationCount: 1 }),
  } as IIndexingMemory & ISchemaCanonicalizationMemory;
}

describe('TASK-MG-031: StageIICanonicalizer', () => {
  let db: Database.Database;
  let store: SQLiteMemoryStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.prepare(`INSERT INTO corpora (corpus_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run('corpus-1', 'Corpus', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    store = new SQLiteMemoryStore(db);
  });

  it('canonicalizes candidate schemas into persisted schema models', async () => {
    const canonicalizer = {
      ...createNotImplementedStub<ISchemaCanonicalizer>('ISchemaCanonicalizer'),
      canonicalize: async () => ({
        canonicalHeadType: 'Person',
        canonicalRelation: 'authors',
        canonicalTailType: 'Paper',
        aliases: [],
        confidence: 0.95,
      }),
    } satisfies ISchemaCanonicalizer;

    const stage = new StageIICanonicalizer('corpus-1', new SnapshotBackedIndexingMemory(store));
    const schemas = await stage.canonicalizeSchemas([createRecord()], canonicalizer);

    expect(schemas).toHaveLength(1);
    expect(schemas[0]?.canonicalKey).toBe('person::authors::paper');
    expect(schemas[0]?.sourceDocumentIds).toEqual(['doc-1']);
  });

  it('prepares the affected delta without mutating and promotes after the merged frequency', async () => {
    const stage = new StageIICanonicalizer('corpus-1', new SnapshotBackedIndexingMemory(store));
    await store.save({ corpusId: 'corpus-1', exportedAt: '2026-01-01T00:00:00.000Z', schemaVersion: 1, passages: [], facts: [], schemas: [{
      schemaId: 'schema:person::authors::paper',
      corpusId: 'corpus-1',
      headType: 'Person',
      relation: 'authors',
      tailType: 'Paper',
      canonicalKey: 'person::authors::paper',
      aliases: [],
      frequency: 1,
      state: 'pending',
      stabilizationThreshold: 2,
      factIds: [],
      sourceDocumentIds: ['doc-old'],
      version: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }] });

    const prepared = await stage.prepareSchemas([{
      schemaId: 'schema:person::authors::paper', corpusId: 'corpus-1', headType: 'Person', relation: 'authors', tailType: 'Paper', canonicalKey: 'person::authors::paper', aliases: [], frequency: 1, state: 'pending', stabilizationThreshold: 2, factIds: [], sourceDocumentIds: ['doc-1'], version: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
    }]);

    const snapshot = await store.load('corpus-1');
    expect(snapshot.schemas[0]?.frequency).toBe(1);
    expect(prepared.newlyStableSchemaIds).toEqual(['schema:person::authors::paper']);
    expect(prepared.finalSchemas[0]).toMatchObject({
      frequency: 2,
      state: 'stable',
      sourceDocumentIds: ['doc-old', 'doc-1'],
    });
  });

  it('folds duplicate candidates in document order and counts each occurrence once', async () => {
    const stage = new StageIICanonicalizer('corpus-1', new SnapshotBackedIndexingMemory(store));
    const candidate = {
      schemaId: 'schema:person::authors::paper', corpusId: 'corpus-1', headType: 'Person', relation: 'authors', tailType: 'Paper', canonicalKey: 'person::authors::paper', aliases: [], frequency: 1, state: 'pending' as const, stabilizationThreshold: 2, factIds: [], sourceDocumentIds: ['doc-1'], version: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };

    const prepared = await stage.prepareSchemas([candidate, candidate]);
    expect(prepared.finalSchemas).toHaveLength(1);
    expect(prepared.finalSchemas[0]).toMatchObject({ frequency: 2, state: 'stable' });
    expect(prepared.finalSchemas[0]?.sourceDocumentIds).toEqual(['doc-1']);
    expect(prepared.newlyStableSchemaIds).toEqual([candidate.schemaId]);
  });

  it('activates inactive facts for newly stable schemas', async () => {
    const indexingMemory = new SnapshotBackedIndexingMemory(store);
    await store.save({ corpusId: 'corpus-1', exportedAt: '2026-01-01T00:00:00.000Z', schemaVersion: 1, passages: [], schemas: [{
      schemaId: 'schema:person::authors::paper', corpusId: 'corpus-1', headType: 'Person', relation: 'authors', tailType: 'Paper', canonicalKey: 'person::authors::paper', aliases: [], frequency: 2, state: 'stable', stabilizationThreshold: 2, factIds: ['fact-1'], sourceDocumentIds: ['doc-1'], version: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }], facts: [{
      factId: 'fact-1', corpusId: 'corpus-1', schemaId: 'schema:person::authors::paper', headEntity: 'Alice', headType: 'Person', relation: 'authors', tailEntity: 'Paper A', tailType: 'Paper', state: 'inactive', passageIds: [], sourceDocumentIds: ['doc-1'], confidence: 0.9, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }] });

    const activated = await indexingMemory.activateFactsBySchemaIds({
      corpusId: 'corpus-1',
      schemaIds: ['schema:person::authors::paper'],
      updatedAt: '2026-02-01T00:00:00.000Z',
    });
    const snapshot = await store.load('corpus-1');

    expect(activated).toBe(1);
    expect(snapshot.facts[0]?.state).toBe('active');
    expect(snapshot.facts[0]?.updatedAt).toBe('2026-02-01T00:00:00.000Z');
  });

  it('aggregates repeated occurrences into one projected CAS delta', async () => {
    const memory = canonicalMemory([projection()]);
    const stage = new StageIICanonicalizer('corpus-1', memory);
    const prepared = await stage.prepareCanonicalSchemas([
      candidateSchema('schema:person::authors::paper', 'authors'),
      candidateSchema('schema:person::authors::paper', 'writes'),
      candidateSchema('schema:person::authors::paper', 'authors'),
    ], 'doc-1');

    expect(prepared.schemaViews).toMatchObject([{
      schemaId: 'schema:person::authors::paper',
      frequency: 4,
      state: 'stable',
      firstSourceDocumentId: 'doc-old',
    }]);
    expect(prepared.mergeIntents).toMatchObject([{
      mode: 'merge',
      frequencyDelta: 3,
      aliasAdditions: expect.arrayContaining([
        expect.objectContaining({ label: 'authors' }),
        expect.objectContaining({ label: 'writes' }),
      ]),
    }]);
  });

  it('projects 33 unique schemas as consecutive capability-sized reads', async () => {
    const schemas = candidateSchemas(33);
    const ids = schemas.map((schema) => schema.schemaId);
    const memory = canonicalMemory([]);
    const stage = new StageIICanonicalizer('corpus-1', memory);
    const outcome = await stage.prepareCanonicalSchemas(schemas, 'doc-1').then(
      (prepared) => ({ ok: true as const, prepared }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const calls = vi.mocked(memory.getSchemaCanonicalizationProjection).mock.calls
      .map(([request]) => request.schemaIds);
    const observedError = outcome.ok
      ? null
      : outcome.error instanceof Error ? outcome.error.message : String(outcome.error);

    expect({
      batchSizes: calls.map((schemaIds) => schemaIds.length),
      error: observedError,
    }).toEqual({ batchSizes: [32, 1], error: null });
    expect(calls).toEqual([ids.slice(0, 32), ids.slice(32)]);
    if (!outcome.ok) return;
    expect(outcome.prepared.schemaViews.map((view) => view.schemaId)).toEqual(ids);
    expect(outcome.prepared.mergeIntents.map((intent) => (
      intent.mode === 'create' ? intent.schema.schemaId : intent.schemaId
    ))).toEqual(ids);
  });

  it('keeps an exact 32-schema projection in one request', async () => {
    const schemas = candidateSchemas(32);
    const memory = canonicalMemory([]);
    const stage = new StageIICanonicalizer('corpus-1', memory);

    const prepared = await stage.prepareCanonicalSchemas(schemas, 'doc-1');

    expect(vi.mocked(memory.getSchemaCanonicalizationProjection).mock.calls
      .map(([request]) => request.schemaIds)).toEqual([schemas.map((schema) => schema.schemaId)]);
    expect(prepared.schemaViews).toHaveLength(32);
  });

  it('projects 65 mixed existing and absent schemas as ordered 32/32/1 reads', async () => {
    const schemas = candidateSchemas(65);
    const ids = schemas.map((schema) => schema.schemaId);
    const existingSchemas = schemas.filter((_, index) => index % 2 === 0);
    const existingIds = existingSchemas.map((schema) => schema.schemaId);
    const memory = canonicalMemory(existingSchemas.map(projectionForCandidate));
    const stage = new StageIICanonicalizer('corpus-1', memory);
    const outcome = await stage.prepareCanonicalSchemas(schemas, 'doc-1').then(
      (prepared) => ({ ok: true as const, prepared }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const calls = vi.mocked(memory.getSchemaCanonicalizationProjection).mock.calls
      .map(([request]) => request.schemaIds);
    const observedError = outcome.ok
      ? null
      : outcome.error instanceof Error ? outcome.error.message : String(outcome.error);

    expect({
      batchSizes: calls.map((schemaIds) => schemaIds.length),
      error: observedError,
    }).toEqual({ batchSizes: [32, 32, 1], error: null });
    expect(calls).toEqual([ids.slice(0, 32), ids.slice(32, 64), ids.slice(64)]);
    if (!outcome.ok) return;
    expect(outcome.prepared.schemaViews.map((view) => view.schemaId)).toEqual(ids);
    expect(outcome.prepared.mergeIntents.map((intent) => (
      intent.mode === 'create' ? intent.schema.schemaId : intent.schemaId
    ))).toEqual(ids);
    expect(outcome.prepared.mergeIntents
      .filter((intent) => intent.mode === 'merge')
      .map((intent) => intent.mode === 'merge' ? intent.schemaId : ''))
      .toEqual(existingIds);
  });

  it('rejects more than 4096 distinct schemas before the first projection RPC', async () => {
    const schemas = candidateSchemas(4097);
    const memory = canonicalMemory([]);
    const stage = new StageIICanonicalizer('corpus-1', memory);

    await expect(stage.prepareCanonicalSchemas(schemas, 'doc-1'))
      .rejects.toThrow('canonical schema count exceeds the indexing bound');
    expect(vi.mocked(memory.getSchemaCanonicalizationProjection)).not.toHaveBeenCalled();
  });

  it('keeps same-document changed content idempotent while unioning new aliases', async () => {
    const memory = canonicalMemory([projection({ contributionPresent: true })]);
    const stage = new StageIICanonicalizer('corpus-1', memory);
    const prepared = await stage.prepareCanonicalSchemas([
      candidateSchema('schema:person::authors::paper', 'new-alias'),
    ], 'doc-1');

    expect(prepared.mergeIntents[0]).toMatchObject({
      mode: 'merge',
      frequencyDelta: 0,
      aliasAdditions: [expect.objectContaining({ label: 'new-alias' })],
    });
    expect(prepared.schemaViews[0]).toMatchObject({
      frequency: 1,
      firstSourceDocumentId: 'doc-old',
      contributionPresent: true,
    });
  });

  it('fails closed when stored scalar meaning disagrees with the candidate', async () => {
    const memory = canonicalMemory([projection({ relation: 'belongsTo' })]);
    const stage = new StageIICanonicalizer('corpus-1', memory);

    await expect(stage.prepareCanonicalSchemas([candidateSchema()], 'doc-1'))
      .rejects.toThrow('inconsistent schema meaning');
  });
});
