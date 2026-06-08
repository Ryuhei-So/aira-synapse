import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../../src/infrastructure/storage/migrate.js';
import { SQLiteMemoryStore } from '../../../../src/infrastructure/storage/SQLiteMemoryStore.js';
import type { CompositeExtractionRecord, ISchemaCanonicalizer } from '../../../../src/domain/agent/index.js';
import { createNotImplementedStub } from '../../../setup/testDoubles.js';
import { StageIICanonicalizer } from '../../../../src/application/indexing/StageIICanonicalizer.js';

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

    const stage = new StageIICanonicalizer('corpus-1', store);
    const schemas = await stage.canonicalizeSchemas([createRecord()], canonicalizer);

    expect(schemas).toHaveLength(1);
    expect(schemas[0]?.canonicalKey).toBe('person::authors::paper');
    expect(schemas[0]?.sourceDocumentIds).toEqual(['doc-1']);
  });

  it('increments schema frequency for existing and new schemas', async () => {
    const stage = new StageIICanonicalizer('corpus-1', store);
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

    await stage.incrementSchemaFrequency([{ 
      schemaId: 'schema:person::authors::paper', corpusId: 'corpus-1', headType: 'Person', relation: 'authors', tailType: 'Paper', canonicalKey: 'person::authors::paper', aliases: [], frequency: 1, state: 'pending', stabilizationThreshold: 2, factIds: [], sourceDocumentIds: ['doc-1'], version: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' 
    }]);

    const snapshot = await store.load('corpus-1');
    expect(snapshot.schemas[0]?.frequency).toBe(2);
    expect(snapshot.schemas[0]?.sourceDocumentIds).toEqual(expect.arrayContaining(['doc-old', 'doc-1']));
    expect(snapshot.schemas[0]?.sourceDocumentIds).toHaveLength(2);
  });

  it('promotes stable schemas when frequency crosses threshold', async () => {
    const stage = new StageIICanonicalizer('corpus-1', store);
    await store.save({ corpusId: 'corpus-1', exportedAt: '2026-01-01T00:00:00.000Z', schemaVersion: 1, passages: [], facts: [], schemas: [{
      schemaId: 'schema:person::authors::paper',
      corpusId: 'corpus-1', headType: 'Person', relation: 'authors', tailType: 'Paper', canonicalKey: 'person::authors::paper', aliases: [], frequency: 2, state: 'pending', stabilizationThreshold: 2, factIds: ['fact-1'], sourceDocumentIds: ['doc-1'], version: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }] });

    const stableIds = await stage.promoteStableSchemas();
    const snapshot = await store.load('corpus-1');

    expect(stableIds).toEqual(['schema:person::authors::paper']);
    expect(snapshot.schemas[0]?.state).toBe('stable');
  });

  it('activates inactive facts for newly stable schemas', async () => {
    const stage = new StageIICanonicalizer('corpus-1', store);
    await store.save({ corpusId: 'corpus-1', exportedAt: '2026-01-01T00:00:00.000Z', schemaVersion: 1, passages: [], schemas: [{
      schemaId: 'schema:person::authors::paper', corpusId: 'corpus-1', headType: 'Person', relation: 'authors', tailType: 'Paper', canonicalKey: 'person::authors::paper', aliases: [], frequency: 2, state: 'stable', stabilizationThreshold: 2, factIds: ['fact-1'], sourceDocumentIds: ['doc-1'], version: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }], facts: [{
      factId: 'fact-1', corpusId: 'corpus-1', schemaId: 'schema:person::authors::paper', headEntity: 'Alice', headType: 'Person', relation: 'authors', tailEntity: 'Paper A', tailType: 'Paper', state: 'inactive', passageIds: [], sourceDocumentIds: ['doc-1'], confidence: 0.9, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }] });

    const activated = await stage.cascadeActivateFacts(['schema:person::authors::paper']);
    const snapshot = await store.load('corpus-1');

    expect(activated).toBe(1);
    expect(snapshot.facts[0]?.state).toBe('active');
  });
});
