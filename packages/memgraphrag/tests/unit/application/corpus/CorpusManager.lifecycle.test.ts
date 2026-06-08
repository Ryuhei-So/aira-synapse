/**
 * Unit tests for CorpusManager lifecycle (create/list/delete).
 * TASK-MG-028: DES-MG-022.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { CorpusManager } from '../../../../src/application/corpus/CorpusManager.js';
import { SQLiteGraphStore } from '../../../../src/infrastructure/storage/SQLiteGraphStore.js';
import { SQLiteLexiconStore } from '../../../../src/infrastructure/storage/SQLiteLexiconStore.js';
import { runMigrations } from '../../../../src/infrastructure/storage/migrate.js';
import { FileVectorIndex } from '../../../../src/infrastructure/storage/FileVectorIndex.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('CorpusManager lifecycle', () => {
  let db: Database.Database;
  let manager: CorpusManager;
  let tmpDir: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-test-'));
    const graphStore = new SQLiteGraphStore(db);
    const vectorIndex = new FileVectorIndex(tmpDir, 3);
    const lexiconStore = new SQLiteLexiconStore(db, 'dummy');

    manager = new CorpusManager(
      db,
      graphStore,
      vectorIndex,
      lexiconStore,
    );
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should create a corpus with name and description', async () => {
    const corpus = await manager.create('Test Corpus', 'A test description');

    expect(corpus.corpusId).toBeTruthy();
    expect(corpus.name).toBe('Test Corpus');
    expect(corpus.description).toBe('A test description');
    expect(corpus.documentCount).toBe(0);
    expect(corpus.nodeCount).toBe(0);
    expect(corpus.createdAt).toBeTruthy();
  });

  it('should create a corpus without description', async () => {
    const corpus = await manager.create('No Desc');

    expect(corpus.name).toBe('No Desc');
    expect(corpus.description).toBeUndefined();
  });

  it('should list all corpora', async () => {
    await manager.create('Corpus A');
    await manager.create('Corpus B', 'desc B');

    const list = await manager.list();
    expect(list).toHaveLength(2);
    expect(list.map((c) => c.name)).toContain('Corpus A');
    expect(list.map((c) => c.name)).toContain('Corpus B');
  });

  it('should return empty list when no corpora exist', async () => {
    const list = await manager.list();
    expect(list).toHaveLength(0);
  });

  it('should delete a corpus and cascade', async () => {
    const corpus = await manager.create('To Delete');

    // Add a document
    db.prepare(
      `INSERT INTO documents (document_id, corpus_id, title, source_url)
       VALUES (?, ?, ?, ?)`,
    ).run('doc-1', corpus.corpusId, 'Doc 1', 'https://example.com');

    // Add a schema
    db.prepare(
      `INSERT INTO schemas (schema_id, corpus_id, head_type, relation, tail_type, canonical_key, frequency, state, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('s-1', corpus.corpusId, 'Person', 'worksAt', 'Org', 'person::worksat::org', 1, 'pending', 1);

    // Add a fact
    db.prepare(
      `INSERT INTO facts (fact_id, corpus_id, schema_id, head_entity, head_type, relation, tail_entity, tail_type, state, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('f-1', corpus.corpusId, 's-1', 'Alice', 'Person', 'worksAt', 'ACME', 'Org', 'active', 0.9);

    // Add graph nodes
    const graphStore = new SQLiteGraphStore(db);
    await graphStore.upsertNodes([
      { nodeId: 'n-1', corpusId: corpus.corpusId, layer: 'ontology', ref: {} as any, label: 'Test' },
    ]);

    const result = await manager.delete(corpus.corpusId);

    expect(result.corpusId).toBe(corpus.corpusId);
    expect(result.deletedDocuments).toBe(1);
    expect(result.deletedNodes).toBe(1);

    // Verify corpus is gone
    const remaining = await manager.list();
    expect(remaining).toHaveLength(0);
  });

  it('should cancel active jobs during delete', async () => {
    const corpus = await manager.create('Job Corpus');

    // Insert pending and running jobs
    db.prepare(
      `INSERT INTO jobs (job_id, corpus_id, status, processed, total)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('j-1', corpus.corpusId, 'pending', 0, 5);
    db.prepare(
      `INSERT INTO jobs (job_id, corpus_id, status, processed, total)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('j-2', corpus.corpusId, 'running', 2, 5);
    db.prepare(
      `INSERT INTO jobs (job_id, corpus_id, status, processed, total)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('j-3', corpus.corpusId, 'completed', 5, 5);

    const result = await manager.delete(corpus.corpusId);
    expect(result.cancelledJobs).toBe(2);
  });
});
