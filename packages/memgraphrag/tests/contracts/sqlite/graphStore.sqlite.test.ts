/**
 * Run IGraphStore contract tests against SQLiteGraphStore.
 */

import { describe } from 'vitest';
import { SQLiteGraphStore } from '../../../src/infrastructure/storage/SQLiteGraphStore.js';
import { openDatabase, runMigrations } from '../../../src/infrastructure/storage/migrate.js';
import { graphStoreContractTests } from '../graphStore.contract.js';
import type Database from 'better-sqlite3';

describe('IGraphStore contract — SQLiteGraphStore', () => {
  let db: Database.Database;

  graphStoreContractTests({
    async create() {
      db = openDatabase(':memory:');
      runMigrations(db);
      db.prepare('INSERT INTO corpora (corpus_id, name, description) VALUES (?, ?, ?)').run('corpus-1', 'Test', '');
      db.prepare('INSERT INTO corpora (corpus_id, name, description) VALUES (?, ?, ?)').run('corpus-2', 'Other', '');
      return new SQLiteGraphStore(db);
    },
    async teardown() {
      db?.close();
    },
  });
});
