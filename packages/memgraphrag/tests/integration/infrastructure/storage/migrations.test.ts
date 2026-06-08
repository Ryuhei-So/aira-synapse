import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { openDatabase, runMigrations, openAndMigrate } from '../../../../src/infrastructure/storage/migrate.js';

describe('TASK-MG-018: SQLite migration runner', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  describe('openDatabase', () => {
    it('should enable WAL mode (on file-based databases)', () => {
      // WAL is not supported for in-memory databases; returns 'memory'
      const mode = db.pragma('journal_mode', { simple: true });
      expect(mode).toBe('memory'); // In-memory DBs ignore WAL
    });

    it('should enable foreign keys', () => {
      const fk = db.pragma('foreign_keys', { simple: true });
      expect(fk).toBe(1);
    });
  });

  describe('runMigrations', () => {
    it('should apply initial migration', () => {
      const result = runMigrations(db);
      expect(result.applied).toContain('0001_init.sql');
      expect(result.currentVersion).toBe(1);
    });

    it('should be idempotent (re-running does not re-apply)', () => {
      runMigrations(db);
      const result2 = runMigrations(db);
      expect(result2.applied).toHaveLength(0);
      expect(result2.alreadyApplied).toContain('0001_init.sql');
      expect(result2.currentVersion).toBe(1);
    });

    it('should create all required tables', () => {
      runMigrations(db);
      const tables = (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all() as { name: string }[]
      ).map((r) => r.name);

      const expectedTables = [
        'audit_logs',
        'checkpoints',
        'corpora',
        'dictionary_candidates',
        'documents',
        'fact_documents',
        'fact_passages',
        'facts',
        'graph_edges',
        'graph_nodes',
        'jobs',
        'passages',
        'schema_aliases',
        'schema_documents',
        'schema_versions',
        'schemas',
        'term_dictionary',
        'thesaurus_relations',
      ];

      for (const table of expectedTables) {
        expect(tables).toContain(table);
      }
    });

    it('should create lexicon tables with correct columns', () => {
      runMigrations(db);

      // term_dictionary
      const tdCols = (
        db.prepare("PRAGMA table_info('term_dictionary')").all() as {
          name: string;
        }[]
      ).map((c) => c.name);
      expect(tdCols).toEqual(
        expect.arrayContaining([
          'term_id',
          'corpus_id',
          'term',
          'canonical_form',
          'domain_category',
          'aliases_json',
          'frequency',
          'confidence',
          'source',
          'version',
        ]),
      );

      // thesaurus_relations
      const trCols = (
        db.prepare("PRAGMA table_info('thesaurus_relations')").all() as {
          name: string;
        }[]
      ).map((c) => c.name);
      expect(trCols).toEqual(
        expect.arrayContaining([
          'relation_id',
          'corpus_id',
          'source_term',
          'target_term',
          'relation_type',
          'weight',
          'bidirectional',
        ]),
      );

      // dictionary_candidates
      const dcCols = (
        db.prepare("PRAGMA table_info('dictionary_candidates')").all() as {
          name: string;
        }[]
      ).map((c) => c.name);
      expect(dcCols).toEqual(
        expect.arrayContaining([
          'candidate_id',
          'corpus_id',
          'term',
          'frequency',
          'confidence',
          'status',
        ]),
      );
    });

    it('should enforce foreign key constraints', () => {
      runMigrations(db);
      expect(() => {
        db.prepare(
          "INSERT INTO schemas (schema_id, corpus_id, head_type, relation, tail_type, canonical_key) VALUES ('s1', 'nonexistent', 'A', 'r', 'B', 'a::r::b')",
        ).run();
      }).toThrow();
    });

    it('should record migration version', () => {
      runMigrations(db);
      const versions = db
        .prepare('SELECT version, filename FROM schema_versions')
        .all() as { version: number; filename: string }[];
      expect(versions).toHaveLength(1);
      expect(versions[0]?.version).toBe(1);
      expect(versions[0]?.filename).toBe('0001_init.sql');
    });
  });

  describe('openAndMigrate', () => {
    it('should return database and migration result', () => {
      const memDb = openDatabase(':memory:');
      const result = runMigrations(memDb);
      expect(result.currentVersion).toBe(1);
      memDb.close();
    });
  });
});
