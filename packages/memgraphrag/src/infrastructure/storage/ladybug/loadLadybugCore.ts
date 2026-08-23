/**
 * Lazy loader for @ladybugdb/core (optional dependency).
 * Returns the LadybugDB module or throws an informative error if not installed.
 */

export interface LadybugModule {
  Database: new (
    path: string,
    bufferManagerSize?: number,
    enableCompression?: boolean,
    readOnly?: boolean,
    maxDBSize?: number,
  ) => LadybugDatabase;
  Connection: new (db: LadybugDatabase) => LadybugConnection;
  VERSION: string;
}

export interface LadybugDatabase {
  close(): void;
}

export interface LadybugConnection {
  query(statement: string): Promise<LadybugQueryResult>;
  prepare(statement: string): Promise<LadybugPreparedStatement>;
  execute(
    ps: LadybugPreparedStatement,
    params?: Record<string, unknown>,
  ): Promise<LadybugQueryResult>;
  close(): void;
}

export interface LadybugPreparedStatement {
  isSuccess(): boolean;
  getErrorMessage(): string;
}

export interface LadybugQueryResult {
  getAll(): Promise<Record<string, unknown>[]>;
}

let cached: LadybugModule | undefined;

/**
 * Dynamically imports @ladybugdb/core.
 * Throws a descriptive error if the package is not installed.
 */
export async function loadLadybugCore(): Promise<LadybugModule> {
  if (cached) return cached;
  try {
    const mod = await import('@ladybugdb/core');
    cached = (mod.default ?? mod) as unknown as LadybugModule;
    return cached;
  } catch {
    throw new Error(
      '@ladybugdb/core is not installed. ' +
        'Install it with: npm install @ladybugdb/core\n' +
        'LadybugDB is required when using backend: "ladybug". ' +
        'The SQLite backend (backend: "sqlite") does not require this package.',
    );
  }
}
