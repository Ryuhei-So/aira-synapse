/**
 * Infrastructure Layer — Storage adapter factory for backend selection.
 * DES-LDB-008: Runtime DI integration — creates SQLite, LadybugDB, or Neo4j adapters.
 */

import type { IGraphStore, IVectorIndex, IMemoryStore } from '../../../domain/storage/graphStore.js';
import type { IIndexingMemory } from '../../../domain/storage/indexingMemory.js';
import type { IGraphProjection, ILexicalRetriever } from '../../../domain/retrieval/ppr.js';
import type {
  AiraGraphDbTerminationResult,
  AiraGraphDbTrafficObserver,
} from '../aira-graphdb/NativeClient.js';

export type StorageBackend = 'sqlite' | 'ladybug' | 'neo4j' | 'aira-graphdb';

export interface StorageAdapters {
  readonly graphStore: IGraphStore;
  readonly vectorIndex: IVectorIndex;
  readonly memoryStore: IMemoryStore;
  readonly indexingMemory: IIndexingMemory;
  readonly graphProjection: IGraphProjection;
  readonly lexicalRetriever: ILexicalRetriever;
  readonly close: () => Promise<void>;
  /** Optional write-batching: defer backend persistence between begin/commit. */
  readonly batch?: {
    readonly begin: () => Promise<void>;
    readonly commit: () => Promise<void>;
    readonly abandon: () => Promise<void>;
  };
}

export interface LadybugStorageOptions {
  readonly dbPath: string;
  readonly vectorDimensions?: number;
}

export interface SQLiteStorageOptions {
  readonly sqlitePath: string;
  readonly vectorIndexDir: string;
}

export interface Neo4jStorageOptions {
  readonly uri: string;
  readonly username: string;
  readonly password: string;
  readonly database?: string;
  readonly vectorDimensions?: number;
}

export interface AiraGraphDbStorageOptions {
  readonly dbPath: string;
  readonly onTraffic?: AiraGraphDbTrafficObserver;
}

export interface StorageOptions {
  readonly backend: StorageBackend;
  readonly ladybug?: LadybugStorageOptions;
  readonly sqlite?: SQLiteStorageOptions;
  readonly neo4j?: Neo4jStorageOptions;
  readonly airaGraphDb?: AiraGraphDbStorageOptions;
}

type AiraGraphDbAcquisitionCleanupError = Error & {
  readonly code: 'AIRA_GRAPHDB_ACQUISITION_CLEANUP_FAILED';
  readonly termination: AiraGraphDbTerminationResult;
};

const AIRA_GRAPHDB_ADAPTER_TERMINATIONS = new WeakMap<
  object,
  Promise<AiraGraphDbTerminationResult>
>();

function acquisitionCleanupError(
  termination: AiraGraphDbTerminationResult,
): AiraGraphDbAcquisitionCleanupError {
  const name = 'AiraGraphDbAcquisitionCleanupError';
  const message = 'aira-graphdb adapter acquisition cleanup failed';
  const error = new Error(message) as AiraGraphDbAcquisitionCleanupError;
  Object.defineProperties(error, {
    name: { value: name, configurable: true },
    code: { value: 'AIRA_GRAPHDB_ACQUISITION_CLEANUP_FAILED', enumerable: true },
    stack: { value: `${name}: ${message}`, configurable: true },
    termination: { value: termination, enumerable: true },
  });
  return Object.freeze(error);
}

/** Package-internal passive receipt for the exact returned GraphDB adapter object. */
export function readAiraGraphDbAdapterTerminationReceipt(
  adapters: unknown,
): Promise<AiraGraphDbTerminationResult> | undefined {
  if ((typeof adapters !== 'object' || adapters === null) && typeof adapters !== 'function') {
    return undefined;
  }
  return AIRA_GRAPHDB_ADAPTER_TERMINATIONS.get(adapters);
}

/**
 * Create LadybugDB-backed storage adapters.
 */
export async function createLadybugAdapters(
  opts: LadybugStorageOptions,
): Promise<StorageAdapters> {
  const { LadybugConnectionPool } = await import('./LadybugConnection.js');
  const { LadybugGraphStore } = await import('./LadybugGraphStore.js');
  const { LadybugVectorIndex } = await import('./LadybugVectorIndex.js');
  const { LadybugMemoryStore } = await import('./LadybugMemoryStore.js');
  const { LadybugGraphProjection } = await import('./LadybugGraphProjection.js');
  const { LadybugLexicalRetriever } = await import('./LadybugLexicalRetriever.js');
  const { SnapshotBackedIndexingMemory } = await import('../SnapshotBackedIndexingMemory.js');

  const pool = new LadybugConnectionPool(opts.dbPath, opts.vectorDimensions);
  await pool.init();

  const graphStore = new LadybugGraphStore(pool);
  const vectorIndex = new LadybugVectorIndex(pool);
  const memoryStore = new LadybugMemoryStore(pool);
  const indexingMemory = new SnapshotBackedIndexingMemory(memoryStore);
  const graphProjection = new LadybugGraphProjection(graphStore);
  const lexicalRetriever = new LadybugLexicalRetriever(pool);

  return {
    graphStore,
    vectorIndex,
    memoryStore,
    indexingMemory,
    graphProjection,
    lexicalRetriever,
    close: () => pool.close(),
  };
}

/**
 * Create Neo4j-backed storage adapters.
 */
export async function createNeo4jAdapters(
  opts: Neo4jStorageOptions,
): Promise<StorageAdapters> {
  const { Neo4jConnectionPool } = await import('../neo4j/Neo4jConnection.js');
  const { Neo4jGraphStore } = await import('../neo4j/Neo4jGraphStore.js');
  const { Neo4jVectorIndex } = await import('../neo4j/Neo4jVectorIndex.js');
  const { Neo4jMemoryStore } = await import('../neo4j/Neo4jMemoryStore.js');
  const { Neo4jGraphProjection } = await import('../neo4j/Neo4jGraphProjection.js');
  const { Neo4jLexicalRetriever } = await import('../neo4j/Neo4jLexicalRetriever.js');
  const { SnapshotBackedIndexingMemory } = await import('../SnapshotBackedIndexingMemory.js');

  const pool = new Neo4jConnectionPool(opts);
  await pool.init();

  const graphStore = new Neo4jGraphStore(pool);
  const vectorIndex = new Neo4jVectorIndex(pool);
  const memoryStore = new Neo4jMemoryStore(pool);
  const indexingMemory = new SnapshotBackedIndexingMemory(memoryStore);
  const graphProjection = new Neo4jGraphProjection(graphStore);
  const lexicalRetriever = new Neo4jLexicalRetriever(pool);

  return {
    graphStore,
    vectorIndex,
    memoryStore,
    indexingMemory,
    graphProjection,
    lexicalRetriever,
    close: () => pool.close(),
  };
}

/**
 * Create storage adapters based on the selected backend.
 * Defaults to SQLite if no backend specified.
 */
export async function createStorageAdapters(
  opts: StorageOptions,
): Promise<StorageAdapters> {
  const backend = opts.backend ?? 'sqlite';

  if (backend === 'ladybug') {
    if (!opts.ladybug) {
      throw new Error('LadybugDB storage options required when backend is "ladybug"');
    }
    return createLadybugAdapters(opts.ladybug);
  }

  if (backend === 'neo4j') {
    if (!opts.neo4j) {
      throw new Error('Neo4j storage options required when backend is "neo4j"');
    }
    return createNeo4jAdapters(opts.neo4j);
  }

  if (backend === 'aira-graphdb') {
    const airaGraphDbOptions = opts.airaGraphDb
      ?? (opts.sqlite
        ? { dbPath: opts.sqlite.sqlitePath }
        : undefined);
    if (!airaGraphDbOptions) {
      throw new Error('Aira GraphDB storage options required when backend is "aira-graphdb"');
    }
    return createAiraGraphDbAdapters(airaGraphDbOptions);
  }

  // SQLite backend (default) — import lazily to avoid requiring better-sqlite3
  if (!opts.sqlite) {
    throw new Error('SQLite storage options required when backend is "sqlite"');
  }

  return createSQLiteAdapters(opts.sqlite);
}

async function createSQLiteAdapters(
  sqlite: SQLiteStorageOptions,
): Promise<StorageAdapters> {
  // SQLite backend (default) — import lazily to avoid requiring better-sqlite3

  const { SQLiteGraphStore } = await import('../SQLiteGraphStore.js');
  const { FileVectorIndex } = await import('../FileVectorIndex.js');
  const { SQLiteMemoryStore } = await import('../SQLiteMemoryStore.js');
  const { SQLiteGraphProjection } = await import(
    '../../../application/query/SQLiteGraphProjection.js'
  );
  const { Bm25LexicalRetriever } = await import(
    '../../retrieval/Bm25LexicalRetriever.js'
  );
  const { SnapshotBackedIndexingMemory } = await import('../SnapshotBackedIndexingMemory.js');
  const { openDatabase, runMigrations } = await import('../migrate.js');

  const db = openDatabase(sqlite.sqlitePath);
  runMigrations(db);

  const graphStore = new SQLiteGraphStore(db);
  const vectorIndex = new FileVectorIndex(sqlite.vectorIndexDir);
  const memoryStore = new SQLiteMemoryStore(db);
  const indexingMemory = new SnapshotBackedIndexingMemory(memoryStore);
  const graphProjection = new SQLiteGraphProjection(graphStore);
  const lexicalRetriever = new Bm25LexicalRetriever();

  return {
    graphStore,
    vectorIndex,
    memoryStore,
    indexingMemory,
    graphProjection,
    lexicalRetriever,
    close: async () => { db.close(); },
  };
}

export async function createAiraGraphDbAdapters(
  opts: AiraGraphDbStorageOptions,
): Promise<StorageAdapters> {
  const {
    AiraGraphDbNativeClient,
    readAiraGraphDbNativeTerminationReceipt,
  } = await import('../aira-graphdb/NativeClient.js');
  const { AiraGraphDbIndexingMemory } = await import('../aira-graphdb/AiraGraphDbIndexingMemory.js');
  const {
    AiraGraphDbGraphStore,
    AiraGraphDbVectorIndex,
    AiraGraphDbMemoryStore,
    AiraGraphDbGraphProjection,
    AiraGraphDbLexicalRetriever,
  } = await import('../aira-graphdb/AiraGraphDbAdapters.js');

  const client = new AiraGraphDbNativeClient(opts.dbPath, opts.onTraffic);
  const termination = readAiraGraphDbNativeTerminationReceipt(client);
  const close = client.close.bind(client);
  let indexingMemory: IIndexingMemory;
  try {
    indexingMemory = await AiraGraphDbIndexingMemory.create(client);
  } catch (error) {
    const closeSettlement = Promise.resolve().then(close);
    const [terminationResult] = await Promise.all([
      termination,
      closeSettlement.then(
        () => undefined,
        () => undefined,
      ),
    ]);
    if (terminationResult.kind !== 'graceful_reaped') {
      throw acquisitionCleanupError(terminationResult);
    }
    throw error;
  }
  const batch = {
    begin: async () => { await client.request('batch_begin', {}); },
    commit: async () => { await client.request('batch_commit', {}); },
    // Disconnect only. Literature Hub remains the sole recovery/commit owner.
    abandon: close,
  };
  const graphStore = new AiraGraphDbGraphStore(client);
  const vectorIndex = new AiraGraphDbVectorIndex(client);
  const memoryStore = new AiraGraphDbMemoryStore(client);
  const graphProjection = new AiraGraphDbGraphProjection(client);
  const lexicalRetriever = new AiraGraphDbLexicalRetriever(client);

  const adapters: StorageAdapters = {
    batch,
    graphStore,
    vectorIndex,
    memoryStore,
    indexingMemory,
    graphProjection,
    lexicalRetriever,
    close,
  };
  AIRA_GRAPHDB_ADAPTER_TERMINATIONS.set(adapters, termination);
  return adapters;
}

/**
 * Resolve storage backend from environment variable or config.
 */
export function resolveBackend(configBackend?: string): StorageBackend {
  const envBackend = process.env.MEMGRAPHRAG_BACKEND;
  const raw = envBackend ?? configBackend ?? 'sqlite';
  if (raw !== 'sqlite' && raw !== 'ladybug' && raw !== 'neo4j' && raw !== 'aira-graphdb') {
    throw new Error(
      `Invalid storage backend: "${raw}". Must be "sqlite", "ladybug", "neo4j", or "aira-graphdb".`,
    );
  }
  return raw;
}
