/**
 * Infrastructure Layer — LadybugDB connection pool and schema management.
 * DES-LDB-001, DES-LDB-002: Connection lifecycle, extension loading, schema initialization.
 */

import { EventEmitter } from 'node:events';
import type {
  LadybugDatabase,
  LadybugConnection as RawConnection,
  LadybugQueryResult,
} from './loadLadybugCore.js';
import { loadLadybugCore } from './loadLadybugCore.js';

/** Events emitted by ILadybugConnectionPool */
export interface LadybugEvents {
  graphMutation: [corpusId: string];
}

/** Abstraction over LadybugDB connection pool for DI / testing. */
export interface ILadybugConnectionPool {
  /** Execute a callback with a pooled connection. Auto-releases on completion. */
  withConnection<T>(fn: (conn: RawConnection) => Promise<T>): Promise<T>;

  /** Convenience: prepare + execute a parameterized query. */
  execute(
    statement: string,
    params?: Record<string, unknown>,
  ): Promise<LadybugQueryResult>;

  /** Convenience: execute a plain Cypher query (no params). */
  query(statement: string): Promise<LadybugQueryResult>;

  /** Emit a graphMutation event (called by adapters after writes). */
  emitGraphMutation(corpusId: string): void;

  /** Subscribe to graphMutation events (for cache invalidation). */
  onGraphMutation(listener: (corpusId: string) => void): void;

  /** Remove a graphMutation listener. */
  offGraphMutation(listener: (corpusId: string) => void): void;

  /** Close all connections and the database. */
  close(): Promise<void>;

  /** Drop and recreate the HNSW vector index (needed after bulk deletes). */
  rebuildVectorIndex(): Promise<void>;
}

const POOL_SIZE = 3;

const EXTENSIONS = ['vector', 'fts', 'algo'] as const;

const SCHEMA_DDL = [
  // --- Node Tables ---
  `CREATE NODE TABLE IF NOT EXISTS GNode(
    pk STRING PRIMARY KEY,
    corpus_id STRING,
    node_id STRING,
    layer STRING,
    label STRING,
    ref_json STRING,
    document_ids STRING
  )`,
  `CREATE NODE TABLE IF NOT EXISTS VectorEntry(
    pk STRING PRIMARY KEY,
    corpus_id STRING,
    entry_id STRING,
    namespace STRING,
    vec FLOAT[3072],
    meta_json STRING,
    document_ids STRING
  )`,
  `CREATE NODE TABLE IF NOT EXISTS SchemaNode(
    pk STRING PRIMARY KEY,
    corpus_id STRING,
    schema_id STRING,
    data_json STRING
  )`,
  `CREATE NODE TABLE IF NOT EXISTS FactNode(
    pk STRING PRIMARY KEY,
    corpus_id STRING,
    fact_id STRING,
    head_entity STRING,
    tail_entity STRING,
    passage_id STRING,
    data_json STRING
  )`,
  `CREATE NODE TABLE IF NOT EXISTS PassageNode(
    pk STRING PRIMARY KEY,
    corpus_id STRING,
    passage_id STRING,
    document_id STRING,
    text STRING,
    data_json STRING
  )`,
  `CREATE NODE TABLE IF NOT EXISTS JobCheckpointNode(
    pk STRING PRIMARY KEY,
    job_id STRING,
    corpus_id STRING,
    processed_doc_ids STRING,
    updated_at STRING
  )`,
  // --- Rel Tables ---
  `CREATE REL TABLE IF NOT EXISTS GEdge(
    FROM GNode TO GNode,
    edge_id STRING,
    corpus_id STRING,
    relation STRING,
    weight FLOAT,
    bridge_kind STRING,
    document_ids STRING
  )`,
] as const;

const INDEX_DDL = [
  // HNSW vector index on VectorEntry
  'CALL CREATE_VECTOR_INDEX("VectorEntry", "vec_idx", "vec")',
  // FTS on PassageNode.text
  'CALL CREATE_FTS_INDEX("PassageNode", "passage_fts_idx", ["text"])',
  // FTS on FactNode entity fields
  'CALL CREATE_FTS_INDEX("FactNode", "fact_fts_idx", ["head_entity", "tail_entity"])',
] as const;

export class LadybugConnectionPool implements ILadybugConnectionPool {
  private db: LadybugDatabase | null = null;
  private pool: RawConnection[] = [];
  private available: RawConnection[] = [];
  private waiting: Array<(conn: RawConnection) => void> = [];
  private readonly events = new EventEmitter();
  private initialized = false;

  constructor(private readonly dbPath: string) {}

  /** Open the database, load extensions, create schema if needed. */
  async init(): Promise<void> {
    if (this.initialized) return;
    const ldb = await loadLadybugCore();

    this.db = new ldb.Database(this.dbPath);
    for (let i = 0; i < POOL_SIZE; i++) {
      const conn = new ldb.Connection(this.db);
      // Load extensions on each connection
      for (const ext of EXTENSIONS) {
        await conn.query(`INSTALL ${ext}; LOAD ${ext};`);
      }
      this.pool.push(conn);
      this.available.push(conn);
    }

    // Create schema (idempotent via IF NOT EXISTS)
    const conn = this.available[0]!;
    for (const ddl of SCHEMA_DDL) {
      await conn.query(ddl);
    }

    // Create indexes (ignore errors if already exist)
    for (const idx of INDEX_DDL) {
      try {
        await conn.query(idx);
      } catch {
        // Index already exists — safe to ignore
      }
    }

    this.initialized = true;
  }

  async withConnection<T>(fn: (conn: RawConnection) => Promise<T>): Promise<T> {
    if (!this.initialized) await this.init();
    const conn = await this.acquire();
    try {
      return await fn(conn);
    } finally {
      this.release(conn);
    }
  }

  async execute(
    statement: string,
    params?: Record<string, unknown>,
  ): Promise<LadybugQueryResult> {
    return this.withConnection(async (conn) => {
      const ps = await conn.prepare(statement);
      return conn.execute(ps, params);
    });
  }

  async query(statement: string): Promise<LadybugQueryResult> {
    return this.withConnection(async (conn) => {
      return conn.query(statement);
    });
  }

  emitGraphMutation(corpusId: string): void {
    this.events.emit('graphMutation', corpusId);
  }

  onGraphMutation(listener: (corpusId: string) => void): void {
    this.events.on('graphMutation', listener);
  }

  offGraphMutation(listener: (corpusId: string) => void): void {
    this.events.off('graphMutation', listener);
  }

  async close(): Promise<void> {
    for (const conn of this.pool) {
      conn.close();
    }
    this.pool = [];
    this.available = [];
    this.waiting = [];
    this.events.removeAllListeners();
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.initialized = false;
  }

  async rebuildVectorIndex(): Promise<void> {
    await this.withConnection(async (conn) => {
      try {
        await conn.query('CALL DROP_VECTOR_INDEX("VectorEntry", "vec_idx")');
      } catch { /* index may not exist */ }
      await conn.query('CALL CREATE_VECTOR_INDEX("VectorEntry", "vec_idx", "vec")');
    });
  }

  // --- Pool internals ---

  private acquire(): Promise<RawConnection> {
    const conn = this.available.pop();
    if (conn) return Promise.resolve(conn);
    return new Promise<RawConnection>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  private release(conn: RawConnection): void {
    const waiter = this.waiting.shift();
    if (waiter) {
      waiter(conn);
    } else {
      this.available.push(conn);
    }
  }
}
