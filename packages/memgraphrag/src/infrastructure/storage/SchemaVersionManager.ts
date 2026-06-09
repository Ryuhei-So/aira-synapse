import type Database from 'better-sqlite3';
import { runMigrations } from './migrate.js';

export class SchemaVersionManager {
  public constructor(private readonly db: Database.Database) {
    this.ensureTrackingTable();
  }

  public getCurrentVersion(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_versions').get() as { version: number };
    return row.version;
  }

  public migrateForward(targetVersion?: number): number {
    runMigrations(this.db);
    this.syncTracking();
    const currentVersion = this.getCurrentVersion();
    if (targetVersion !== undefined && currentVersion < targetVersion) {
      throw new Error(`Target version ${targetVersion} is not available`);
    }
    return targetVersion === undefined ? currentVersion : Math.min(currentVersion, targetVersion);
  }

  public rollback(targetVersion: number): number {
    const currentVersion = this.getCurrentVersion();
    if (targetVersion < 0 || targetVersion > currentVersion) {
      throw new Error(`Invalid rollback target ${targetVersion}`);
    }

    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM schema_versions WHERE version > ?').run(targetVersion);
      this.db.prepare('DELETE FROM schema_version_tracking WHERE version > ?').run(targetVersion);
      this.db.prepare("UPDATE schema_version_tracking SET state = 'rolled_back' WHERE version = ?").run(targetVersion);
    });
    tx();
    return this.getCurrentVersion();
  }

  private ensureTrackingTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version_tracking (
        version INTEGER PRIMARY KEY,
        filename TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'applied',
        tracked_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  private syncTracking(): void {
    this.ensureTrackingTable();
    this.db.exec(`
      INSERT OR REPLACE INTO schema_version_tracking (version, filename, state, tracked_at)
      SELECT version, filename, 'applied', datetime('now')
      FROM schema_versions;
    `);
  }
}
