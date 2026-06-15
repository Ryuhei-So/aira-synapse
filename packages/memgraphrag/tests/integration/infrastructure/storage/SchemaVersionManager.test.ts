import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../../src/infrastructure/storage/migrate.js';
import { SchemaVersionManager } from '../../../../src/infrastructure/storage/SchemaVersionManager.js';

describe('TASK-MG-054: SchemaVersionManager', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => {
    db.close();
  });

  it('reports the current schema version after migrations', () => {
    runMigrations(db);
    const manager = new SchemaVersionManager(db);

    expect(manager.getCurrentVersion()).toBe(4);
  });

  it('rolls back tracked versions and can migrate forward again', () => {
    const manager = new SchemaVersionManager(db);
    manager.migrateForward();
    expect(manager.getCurrentVersion()).toBe(4);

    expect(manager.rollback(1)).toBe(1);
    expect(manager.getCurrentVersion()).toBe(1);
    expect(manager.migrateForward()).toBe(4);
  });

  it('persists tracking rows for applied versions', () => {
    const manager = new SchemaVersionManager(db);
    manager.migrateForward();

    const rows = db.prepare('SELECT version, state FROM schema_version_tracking ORDER BY version').all() as { version: number; state: string }[];
    expect(rows).toEqual([
      { version: 1, state: 'applied' },
      { version: 2, state: 'applied' },
      { version: 3, state: 'applied' },
      { version: 4, state: 'applied' },
    ]);
  });
});
