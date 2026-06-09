import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { SQLiteMemoryStore } from '../../../../src/infrastructure/storage/SQLiteMemoryStore.js';
import { openDatabase, runMigrations } from '../../../../src/infrastructure/storage/migrate.js';
import type { Fact } from '../../../../src/domain/memory/fact.js';
import type { MemorySnapshot } from '../../../../src/domain/memory/globalMemory.js';
import type { Passage } from '../../../../src/domain/memory/passage.js';
import type { Schema } from '../../../../src/domain/memory/schema.js';

const CORPUS_ID = 'corpus-1';
const TIMESTAMP = '2025-01-01T00:00:00.000Z';

function createSchema(): Schema {
  return {
    schemaId: 'schema-1',
    corpusId: CORPUS_ID,
    headType: 'Author',
    relation: 'writes',
    tailType: 'Paper',
    canonicalKey: 'author::writes::paper',
    aliases: [
      {
        label: 'Author writes Paper',
        language: 'en',
        source: 'manual',
        confidence: 1,
        isCanonical: true,
      },
      {
        label: '著者が論文を書く',
        language: 'ja',
        source: 'import',
        confidence: 0.9,
        isCanonical: false,
      },
    ],
    frequency: 3,
    state: 'stable',
    stabilizationThreshold: 2,
    factIds: ['fact-1'],
    sourceDocumentIds: ['doc-1'],
    version: 2,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

function createFact(): Fact {
  return {
    factId: 'fact-1',
    corpusId: CORPUS_ID,
    schemaId: 'schema-1',
    headEntity: 'Ada Lovelace',
    headType: 'Author',
    relation: 'writes',
    tailEntity: 'Notes',
    tailType: 'Paper',
    state: 'active',
    passageIds: ['passage-1'],
    sourceDocumentIds: ['doc-1'],
    confidence: 0.96,
    temporalScope: '1843',
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

function createPassage(): Passage {
  return {
    passageId: 'passage-1',
    corpusId: CORPUS_ID,
    text: 'Ada Lovelace wrote notes on the Analytical Engine.',
    normalizedText: 'ada lovelace wrote notes on the analytical engine',
    metadata: {
      documentId: 'doc-1',
      title: 'Analytical Engine Notes',
      sourceUrl: 'https://example.com/notes',
      sourceType: 'md',
      language: 'en',
      convertedAt: TIMESTAMP,
      sectionPath: ['Introduction'],
      chunkId: 'chunk-1',
      chunkIndex: 0,
      offsetStart: 0,
      offsetEnd: 52,
    },
    factIds: ['fact-1'],
    entityMentions: ['Ada Lovelace', 'Analytical Engine'],
    qualityFlags: [],
    qualityScore: 0.88,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

function createSnapshot(): MemorySnapshot {
  return {
    corpusId: CORPUS_ID,
    exportedAt: TIMESTAMP,
    schemas: [createSchema()],
    facts: [createFact()],
    passages: [createPassage()],
    schemaVersion: 1,
  };
}

describe('TASK-MG-020: SQLiteMemoryStore integration', () => {
  let db: Database.Database;
  let store: SQLiteMemoryStore;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db);
    db.prepare(
      'INSERT INTO corpora (corpus_id, name, description) VALUES (?, ?, ?)',
    ).run(CORPUS_ID, 'Test Corpus', 'Memory store integration corpus');
    store = new SQLiteMemoryStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('round-trips a snapshot from authoritative SQLite state', async () => {
    const snapshot = createSnapshot();

    await store.save(snapshot);
    const loaded = await store.load(CORPUS_ID);

    expect(loaded.corpusId).toBe(CORPUS_ID);
    expect(loaded.schemaVersion).toBe(2);
    expect(loaded.schemas).toEqual(snapshot.schemas);
    expect(loaded.facts).toEqual(snapshot.facts);
    expect(loaded.passages).toEqual(snapshot.passages);
  });

  it('upserts updated schemas, facts, and passages', async () => {
    await store.save(createSnapshot());

    const updatedSnapshot: MemorySnapshot = {
      ...createSnapshot(),
      schemas: [
        {
          ...createSchema(),
          frequency: 5,
          aliases: [
            {
              label: 'Canonical relation',
              language: 'en',
              source: 'manual',
              confidence: 1,
              isCanonical: true,
            },
          ],
        },
      ],
      facts: [
        {
          ...createFact(),
          confidence: 0.5,
          passageIds: ['passage-1', 'passage-2'],
        },
      ],
      passages: [
        createPassage(),
        {
          ...createPassage(),
          passageId: 'passage-2',
          text: 'Updated supporting evidence.',
          normalizedText: 'updated supporting evidence',
          metadata: {
            ...createPassage().metadata,
            chunkId: 'chunk-2',
            chunkIndex: 1,
            offsetEnd: 27,
          },
          factIds: ['fact-1'],
          entityMentions: ['supporting evidence'],
          qualityFlags: ['short_chunk'],
        },
      ],
    };

    await store.save(updatedSnapshot);
    const loaded = await store.load(CORPUS_ID);

    expect(loaded.schemas[0]).toMatchObject({
      frequency: 5,
      aliases: [
        expect.objectContaining({ label: 'Canonical relation', isCanonical: true }),
      ],
    });
    expect(loaded.facts[0]).toMatchObject({
      confidence: 0.5,
      passageIds: ['passage-1', 'passage-2'],
    });
    expect(loaded.passages).toHaveLength(2);
  });

  it('persists and loads checkpoints for resume support', async () => {
    await store.saveCheckpoint({
      jobId: 'job-1',
      corpusId: CORPUS_ID,
      processedDocumentIds: ['doc-1', 'doc-2'],
      updatedAt: TIMESTAMP,
    });

    const checkpoint = await store.loadCheckpoint('job-1');
    const missing = await store.loadCheckpoint('job-missing');

    expect(checkpoint).toEqual({
      jobId: 'job-1',
      corpusId: CORPUS_ID,
      processedDocumentIds: ['doc-1', 'doc-2'],
      updatedAt: TIMESTAMP,
    });
    expect(missing).toBeNull();
  });

  it('reports broken Φ, broken Ψ, and orphan edges', async () => {
    db.pragma('foreign_keys = OFF');
    db.prepare(
      `INSERT INTO facts (
         fact_id, corpus_id, schema_id, head_entity, head_type, relation, tail_entity,
         tail_type, state, confidence, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'fact-broken',
      CORPUS_ID,
      'schema-missing',
      'Ada Lovelace',
      'Author',
      'writes',
      'Notes',
      'Paper',
      'active',
      1,
      TIMESTAMP,
      TIMESTAMP,
    );
    db.prepare(
      `INSERT INTO fact_passages (fact_id, passage_id) VALUES (?, ?)`,
    ).run('fact-broken', 'passage-missing');
    db.prepare(
      `INSERT INTO graph_edges (
         edge_id, corpus_id, source_node_id, target_node_id, relation, weight
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('edge-orphan', CORPUS_ID, 'missing-source', 'missing-target', 'part_of', 1);
    db.pragma('foreign_keys = ON');

    const issues = await store.validateIntegrity(CORPUS_ID);

    expect(issues).toEqual(
      expect.arrayContaining([
        'Broken Φ: fact fact-broken references missing schema schema-missing',
        'Broken Ψ: fact fact-broken references missing passage passage-missing',
        'Orphan edge: edge-orphan (missing-source -> missing-target)',
      ]),
    );
  });

  it('requires the corpus row to exist before saving', async () => {
    db.prepare('DELETE FROM corpora WHERE corpus_id = ?').run(CORPUS_ID);

    await expect(store.save(createSnapshot())).rejects.toThrow(
      `Corpus ${CORPUS_ID} does not exist`,
    );
  });
});
