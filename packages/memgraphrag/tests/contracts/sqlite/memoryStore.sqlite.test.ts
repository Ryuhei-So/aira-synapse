/**
 * Run IMemoryStore contract tests against SQLiteMemoryStore.
 */

import { describe } from 'vitest';
import { SQLiteMemoryStore } from '../../../src/infrastructure/storage/SQLiteMemoryStore.js';
import { openDatabase, runMigrations } from '../../../src/infrastructure/storage/migrate.js';
import { memoryStoreContractTests } from '../memoryStore.contract.js';
import type Database from 'better-sqlite3';

describe('IMemoryStore contract — SQLiteMemoryStore', () => {
  let db: Database.Database;

  memoryStoreContractTests({
    async create() {
      db = openDatabase(':memory:');
      runMigrations(db);
      db.prepare('INSERT INTO corpora (corpus_id, name, description) VALUES (?, ?, ?)').run('corpus-1', 'Test', '');
      return new SQLiteMemoryStore(db);
    },
    async teardown() {
      db?.close();
    },
  });
});
