/**
 * SQLite migration runner.
 * DES-MG-030, DES-MG-032: WAL mode, foreign keys, schema version tracking.
 */

import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATIONS_DIR = resolve(import.meta.dirname, 'migrations');

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
  readonly currentVersion: number;
}

/**
 * Opens a SQLite database with standard pragmas.
 */
export function openDatabase(sqlitePath: string): Database.Database {
  const db = new Database(sqlitePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

/**
 * Runs all pending migrations on the given database.
 * Migrations are SQL files in the migrations/ directory, sorted by filename.
 * Each migration is applied in a transaction and recorded in schema_versions.
 */
export function runMigrations(db: Database.Database): MigrationResult {
  // Ensure schema_versions table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_versions (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now')),
      filename   TEXT NOT NULL
    );
  `);

  const appliedVersions = new Set<number>(
    (db.prepare('SELECT version FROM schema_versions').all() as { version: number }[])
      .map((r) => r.version),
  );

  const migrationFiles = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  for (const file of migrationFiles) {
    const versionMatch = file.match(/^(\d+)/);
    if (!versionMatch?.[1]) continue;

    const version = parseInt(versionMatch[1], 10);
    if (appliedVersions.has(version)) {
      alreadyApplied.push(file);
      continue;
    }

    const sql = readFileSync(resolve(MIGRATIONS_DIR, file), 'utf-8');

    const transaction = db.transaction(() => {
      db.exec(sql);
      db.prepare(
        'INSERT INTO schema_versions (version, filename) VALUES (?, ?)',
      ).run(version, file);
    });
    transaction();

    applied.push(file);
    appliedVersions.add(version);
  }

  const maxVersion =
    appliedVersions.size > 0 ? Math.max(...appliedVersions) : 0;

  return {
    applied,
    alreadyApplied,
    currentVersion: maxVersion,
  };
}

/**
 * Opens a database and runs all pending migrations.
 * Returns the database instance ready for use.
 */
export function openAndMigrate(sqlitePath: string): {
  db: Database.Database;
  migration: MigrationResult;
} {
  const db = openDatabase(sqlitePath);
  const migration = runMigrations(db);
  return { db, migration };
}
