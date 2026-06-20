/**
 * Infrastructure Layer — Neo4j Community Edition connection pool.
 * Manages driver lifecycle, schema initialization (constraints + indexes).
 */

import { EventEmitter } from 'node:events';
import neo4j, {
  type Driver,
  type Session,
  type QueryResult,
} from 'neo4j-driver';

export interface Neo4jConnectionOptions {
  readonly uri: string;       // bolt://localhost:7687
  readonly username: string;  // neo4j
  readonly password: string;
  readonly database?: string; // default: neo4j
  readonly vectorDimensions?: number; // default: 3072
}

export interface INeo4jConnectionPool {
  /** Run a Cypher query with parameters. */
  execute(
    cypher: string,
    params?: Record<string, unknown>,
  ): Promise<QueryResult>;

  /** Run a callback within a session (for transactions). */
  withSession<T>(fn: (session: Session) => Promise<T>): Promise<T>;

  /** Emit a graphMutation event. */
  emitGraphMutation(corpusId: string): void;
  onGraphMutation(listener: (corpusId: string) => void): void;
  offGraphMutation(listener: (corpusId: string) => void): void;

  /** Close the driver. */
  close(): Promise<void>;

  /** Rebuild vector index after bulk deletes. */
  rebuildVectorIndex(): Promise<void>;
}

// Schema initialization: constraints + indexes for Neo4j
const SCHEMA_CYPHER = [
  // Unique constraints
  'CREATE CONSTRAINT gnode_pk IF NOT EXISTS FOR (n:GNode) REQUIRE n.pk IS UNIQUE',
  'CREATE CONSTRAINT vector_pk IF NOT EXISTS FOR (n:VectorEntry) REQUIRE n.pk IS UNIQUE',
  'CREATE CONSTRAINT schema_pk IF NOT EXISTS FOR (n:SchemaNode) REQUIRE n.pk IS UNIQUE',
  'CREATE CONSTRAINT fact_pk IF NOT EXISTS FOR (n:FactNode) REQUIRE n.pk IS UNIQUE',
  'CREATE CONSTRAINT passage_pk IF NOT EXISTS FOR (n:PassageNode) REQUIRE n.pk IS UNIQUE',
  'CREATE CONSTRAINT checkpoint_pk IF NOT EXISTS FOR (n:JobCheckpointNode) REQUIRE n.pk IS UNIQUE',

  // Performance indexes
  'CREATE INDEX gnode_corpus IF NOT EXISTS FOR (n:GNode) ON (n.corpus_id)',
  'CREATE INDEX gnode_layer IF NOT EXISTS FOR (n:GNode) ON (n.corpus_id, n.layer)',
  'CREATE INDEX vector_corpus IF NOT EXISTS FOR (n:VectorEntry) ON (n.corpus_id, n.namespace)',
  'CREATE INDEX schema_corpus IF NOT EXISTS FOR (n:SchemaNode) ON (n.corpus_id)',
  'CREATE INDEX fact_corpus IF NOT EXISTS FOR (n:FactNode) ON (n.corpus_id)',
  'CREATE INDEX passage_corpus IF NOT EXISTS FOR (n:PassageNode) ON (n.corpus_id)',
  'CREATE INDEX passage_doc IF NOT EXISTS FOR (n:PassageNode) ON (n.corpus_id, n.document_id)',
] as const;

// Vector index creation uses configured dimensions (default 3072)
function buildVectorIndexCypher(dimensions: number): string {
  return `CREATE VECTOR INDEX vector_idx IF NOT EXISTS
   FOR (n:VectorEntry) ON (n.vec)
   OPTIONS {indexConfig: {
     \`vector.dimensions\`: ${dimensions},
     \`vector.similarity_function\`: 'cosine'
   }}`;
}

// Full-text indexes
const FTS_INDEX_CYPHER = [
  `CREATE FULLTEXT INDEX passage_fts_idx IF NOT EXISTS
   FOR (n:PassageNode) ON EACH [n.text]`,
  `CREATE FULLTEXT INDEX fact_fts_idx IF NOT EXISTS
   FOR (n:FactNode) ON EACH [n.head_entity, n.tail_entity]`,
] as const;

export class Neo4jConnectionPool implements INeo4jConnectionPool {
  private driver: Driver | null = null;
  private readonly events = new EventEmitter();
  private initialized = false;
  private readonly database: string;
  private readonly vectorDimensions: number;

  constructor(private readonly opts: Neo4jConnectionOptions) {
    this.database = opts.database ?? 'neo4j';
    this.vectorDimensions = opts.vectorDimensions ?? 3072;
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    this.driver = neo4j.driver(
      this.opts.uri,
      neo4j.auth.basic(this.opts.username, this.opts.password),
    );

    // Verify connectivity
    await this.driver.verifyConnectivity();

    // Create schema (idempotent)
    const session = this.driver.session({ database: this.database });
    try {
      for (const stmt of SCHEMA_CYPHER) {
        await session.run(stmt);
      }
      // Vector index
      try {
        await session.run(buildVectorIndexCypher(this.vectorDimensions));
      } catch {
        // May already exist or vector not supported
      }
      // FTS indexes
      for (const stmt of FTS_INDEX_CYPHER) {
        try {
          await session.run(stmt);
        } catch {
          // May already exist
        }
      }
    } finally {
      await session.close();
    }

    this.initialized = true;
  }

  async execute(
    cypher: string,
    params?: Record<string, unknown>,
  ): Promise<QueryResult> {
    if (!this.driver) throw new Error('Neo4j driver not initialized');
    const session = this.driver.session({ database: this.database });
    try {
      return await session.run(cypher, params ?? {});
    } finally {
      await session.close();
    }
  }

  async withSession<T>(fn: (session: Session) => Promise<T>): Promise<T> {
    if (!this.driver) throw new Error('Neo4j driver not initialized');
    const session = this.driver.session({ database: this.database });
    try {
      return await fn(session);
    } finally {
      await session.close();
    }
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
    this.events.removeAllListeners();
    if (this.driver) {
      await this.driver.close();
      this.driver = null;
    }
    this.initialized = false;
  }

  async rebuildVectorIndex(): Promise<void> {
    // Neo4j vector index is automatically maintained — no rebuild needed.
    // Drop + recreate only if search results are stale.
    try {
      await this.execute('DROP INDEX vector_idx IF EXISTS');
      await this.execute(buildVectorIndexCypher(this.vectorDimensions));
    } catch {
      // Ignore errors
    }
  }
}
