import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import type {
  DictionaryCommand,
  DictionaryResult,
  DictionaryService,
  DocumentIndexingPipeline,
  QueryService,
  QueryResponse,
  ThesaurusCommand,
  ThesaurusResult,
  ThesaurusService,
} from '../../application/index.js';
import {
  AsyncJobRunner,
  BuildDictionaryFromApi,
  CorpusManager as DefaultCorpusManager,
  DefaultDictionaryService,
  DefaultBoundedQueryPlanner,
  DefaultIndexingService,
  DefaultQueryService,
  DefaultThesaurusService,
  DeleteDocumentService,
  ThesaurusExpansionPolicy,
} from '../../application/index.js';
import { FullDocumentIndexingPipeline } from '../../application/indexing/FullDocumentIndexingPipeline.js';
import { VectorMemoryFilter } from '../../application/query/VectorMemoryFilter.js';
import { SimpleNodeInitializer } from '../../application/query/SimpleNodeInitializer.js';
import { SimplePPR } from '../../application/query/SimplePPR.js';
import type { QueryHyperParams } from '../../application/query/QueryService.js';
import { SQLiteGraphProjection } from '../../application/query/SQLiteGraphProjection.js';
import { SimpleContextBuilder } from '../../application/query/SimpleContextBuilder.js';
import type {
  IEmbeddingProvider,
  IGraphProjection,
  IGraphStore,
  IIndexingMemory,
  ILLMProvider,
  IMemoryStore,
  INLPExtractor,
  ITermDictionary,
  IThesaurus,
  IVectorIndex,
  QueryRequest,
  RetrievedQueryContext,
} from '../../domain/index.js';
import {
  FileVectorIndex,
  OpenAIEmbeddingProvider,
  OpenAILLMProvider,
  PythonSidecarExtractor,
  RegexExtractor,
  SQLiteGraphStore,
  SQLiteLexiconStore,
  SQLiteMemoryStore,
  SnapshotBackedIndexingMemory,
  SemanticScholarCache,
  SemanticScholarClient,
  openDatabase,
  runMigrations,
} from '../../infrastructure/index.js';
import type { MemGraphRagConfig } from '../../infrastructure/config/index.js';
import { resolveApiKey } from '../../infrastructure/config/index.js';
import { createAiraGraphDbAdapters, resolveBackend, type StorageAdapters } from '../../infrastructure/storage/ladybug/storageFactory.js';

export interface MemGraphRagRuntime {
  start(): Promise<void>;
  shutdown(): Promise<void>;
  getService<T>(token: symbol): T;
}

export const SERVICE_TOKENS = {
  GRAPH_STORE: Symbol('IGraphStore'),
  VECTOR_INDEX: Symbol('IVectorIndex'),
  MEMORY_STORE: Symbol('IMemoryStore'),
  LLM_PROVIDER: Symbol('ILLMProvider'),
  EMBEDDING_PROVIDER: Symbol('IEmbeddingProvider'),
  NLP_EXTRACTOR: Symbol('INLPExtractor'),
  TERM_DICTIONARY: Symbol('ITermDictionary'),
  THESAURUS: Symbol('IThesaurus'),
  CORPUS_MANAGER: Symbol('CorpusManager'),
  INDEXING_SERVICE: Symbol('IndexingService'),
  QUERY_SERVICE: Symbol('QueryService'),
  DICTIONARY_SERVICE: Symbol('DictionaryService'),
  THESAURUS_SERVICE: Symbol('ThesaurusService'),
  DB: Symbol('Database'),
} as const;

const RUNTIME_CORPUS_ID = '__runtime__';

function createConfiguredEmbeddingProvider(config: MemGraphRagConfig): IEmbeddingProvider {
  const apiKey = resolveApiKey(config.providers.apiKeyFile);
  return config.localOnly
    ? new FeatureUnavailableEmbeddingProvider()
    : new OpenAIEmbeddingProvider({
      apiKey,
      model: config.providers.embedding.model,
      baseUrl: process.env['OPENAI_EMBEDDING_BASE_URL'] ?? process.env['OPENAI_BASE_URL'],
      // Existing persisted vectors use the provider model's default dimensions.
      // Forwarding the optional config requires a vector-generation migration;
      // this additive planner must share the existing runtime authority.
    });
}

/** Build the producer-owned V15 planner without opening any storage backend. */
export function createBoundedQueryPlanner(config: MemGraphRagConfig): DefaultBoundedQueryPlanner {
  return new DefaultBoundedQueryPlanner({
    embeddingProvider: createConfiguredEmbeddingProvider(config),
  });
}

interface DictionaryBuildResult {
  readonly termCount: number;
  readonly domainDistribution: Readonly<Record<string, number>>;
}

interface DictionaryServiceWithApi extends DictionaryService {
  buildFromApi(corpusId: string, domains: readonly string[], maxPapers: number): Promise<DictionaryBuildResult>;
}

interface CorpusManagerLike {
  create(name: string, description?: string): ReturnType<DefaultCorpusManager['create']>;
  delete(corpusId: string): ReturnType<DefaultCorpusManager['delete']>;
  list(): ReturnType<DefaultCorpusManager['list']>;
  getStats(corpusId: string): ReturnType<DefaultCorpusManager['getStats']>;
  getJobStatus(jobId: string): ReturnType<DefaultCorpusManager['getJobStatus']>;
  cancelJob(jobId: string): ReturnType<DefaultCorpusManager['cancelJob']>;
  analyzeConflicts(corpusId: string): ReturnType<DefaultCorpusManager['analyzeConflicts']>;
  exportGraph(corpusId: string, format: 'graphml' | 'json', offset: number, limit: number): ReturnType<DefaultCorpusManager['exportGraph']>;
}

class FeatureUnavailableLLMProvider implements ILLMProvider {
  public async generate(): Promise<never> {
    throw new Error('FEATURE_REQUIRES_API: LLM provider is not configured');
  }

  public async healthCheck() {
    return { healthy: false, message: 'FEATURE_REQUIRES_API: LLM provider is not configured' };
  }
}

class FeatureUnavailableEmbeddingProvider implements IEmbeddingProvider {
  public async embed(): Promise<never> {
    throw new Error('LOCAL_EMBEDDING_REQUIRED: embedding provider is not configured');
  }

  public async healthCheck() {
    return { healthy: false, message: 'LOCAL_EMBEDDING_REQUIRED: embedding provider is not configured' };
  }
}

class MinimalDocumentIndexingPipeline implements DocumentIndexingPipeline {
  public constructor(private readonly db: Database.Database) {}

  public async processDocument(corpusId: string, document: { documentId: string; title: string; sourceUrl: string; doi?: string; sourceDb?: string; sourceType?: string; language?: string }) {
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT OR REPLACE INTO documents (
        document_id, corpus_id, title, source_url, doi, source_db, source_type, language, converted_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      document.documentId,
      corpusId,
      document.title,
      document.sourceUrl,
      document.doi ?? null,
      document.sourceDb ?? null,
      document.sourceType ?? null,
      document.language ?? 'unknown',
      now,
      now,
      now,
    );

    return {
      processedDocumentId: document.documentId,
      addedNodes: 0,
      addedEdges: 0,
      conflicts: 0,
    };
  }
}

class CorpusManagerFacade implements CorpusManagerLike {
  public constructor(
    private readonly db: Database.Database,
    private readonly graphStore: IGraphStore,
    private readonly vectorIndex: IVectorIndex,
  ) {}

  private createManager(corpusId = RUNTIME_CORPUS_ID): DefaultCorpusManager {
    return new DefaultCorpusManager(
      this.db,
      this.graphStore,
      this.vectorIndex,
      new SQLiteLexiconStore(this.db, corpusId),
    );
  }

  public async create(name: string, description?: string) {
    return this.createManager().create(name, description);
  }

  public async delete(corpusId: string) {
    return this.createManager(corpusId).delete(corpusId);
  }

  public async list() {
    return this.createManager().list();
  }

  public async getStats(corpusId: string) {
    return this.createManager(corpusId).getStats(corpusId);
  }

  public async getJobStatus(jobId: string) {
    return this.createManager().getJobStatus(jobId);
  }

  public async cancelJob(jobId: string) {
    return this.createManager().cancelJob(jobId);
  }

  public async analyzeConflicts(corpusId: string) {
    return this.createManager().analyzeConflicts(corpusId);
  }

  public async exportGraph(corpusId: string, format: 'graphml' | 'json', offset: number, limit: number) {
    return this.createManager().exportGraph(corpusId, format, offset, limit);
  }
}

class DictionaryServiceFacade implements DictionaryServiceWithApi {
  public constructor(
    private readonly db: Database.Database,
    private readonly config: MemGraphRagConfig,
  ) {}

  public async handle(command: DictionaryCommand): Promise<DictionaryResult> {
    const service = new DefaultDictionaryService(new SQLiteLexiconStore(this.db, command.corpusId));
    return service.handle(command);
  }

  public async buildFromApi(
    corpusId: string,
    domains: readonly string[],
    maxPapers: number,
  ): Promise<DictionaryBuildResult> {
    if (this.config.localOnly) {
      throw new Error('FEATURE_REQUIRES_API: Semantic Scholar API is unavailable in local-only mode');
    }

    const cache = new SemanticScholarCache(resolve(process.cwd(), this.config.dataDir, 'semantic-scholar-cache'));
    const builder = new BuildDictionaryFromApi(
      new SQLiteLexiconStore(this.db, corpusId),
      new SemanticScholarClient({ cache }),
    );
    return builder.buildFromApi(corpusId, domains, maxPapers);
  }
}

class ThesaurusServiceFacade implements ThesaurusService {
  public constructor(private readonly db: Database.Database) {}

  public async handle(command: ThesaurusCommand): Promise<ThesaurusResult> {
    const service = new DefaultThesaurusService(new SQLiteLexiconStore(this.db, command.corpusId));
    return service.handle(command);
  }
}

class QueryServiceFacade implements QueryService {
  public constructor(
    private readonly db: Database.Database,
    private readonly llm: ILLMProvider,
    private readonly embeddingProvider: IEmbeddingProvider,
    private readonly vectorIndex: IVectorIndex,
    private readonly memoryStore: IMemoryStore,
    private readonly graphStore: IGraphStore,
    private readonly graphProjection: IGraphProjection,
  ) {}

  public async query(request: QueryRequest, hyperParams?: QueryHyperParams): Promise<QueryResponse> {
    const dictionary = new SQLiteLexiconStore(this.db, request.corpusId);
    const thesaurus = new SQLiteLexiconStore(this.db, request.corpusId);
    const hp = hyperParams;
    const service = new DefaultQueryService({
      dictionary,
      expansionPolicy: new ThesaurusExpansionPolicy(thesaurus),
      memoryFilter: new VectorMemoryFilter(this.embeddingProvider, this.vectorIndex, this.memoryStore, this.graphStore),
      nodeInitializer: new SimpleNodeInitializer(this.memoryStore),
      ppr: new SimplePPR(),
      projection: this.graphProjection,
      contextBuilder: new SimpleContextBuilder(this.memoryStore),
      llm: this.llm,
      hyperParams: hp,
    });
    return service.query(request);
  }

  public async retrieve(request: QueryRequest, precomputedVector?: readonly number[]): Promise<RetrievedQueryContext> {
    const dictionary = new SQLiteLexiconStore(this.db, request.corpusId);
    const thesaurus = new SQLiteLexiconStore(this.db, request.corpusId);
    const service = new DefaultQueryService({
      dictionary,
      expansionPolicy: new ThesaurusExpansionPolicy(thesaurus),
      memoryFilter: new VectorMemoryFilter(this.embeddingProvider, this.vectorIndex, this.memoryStore, this.graphStore),
      nodeInitializer: new SimpleNodeInitializer(this.memoryStore),
      ppr: new SimplePPR(),
      projection: this.graphProjection,
      contextBuilder: new SimpleContextBuilder(this.memoryStore),
      llm: this.llm,
    });
    return service.retrieve(request, precomputedVector);
  }
}

class RuntimeImpl implements MemGraphRagRuntime {
  private readonly services = new Map<symbol, unknown>();
  private db?: Database.Database;
  private storageClose: (() => Promise<void>) | undefined;
  private jobRunner: AsyncJobRunner | undefined;
  private started = false;

  public constructor(private readonly config: MemGraphRagConfig) {}

  public async start(): Promise<void> {
    if (this.started) {
      return;
    }

    const sqlitePath = resolve(process.cwd(), this.config.storage.sqlitePath);
    const vectorIndexDir = resolve(process.cwd(), this.config.storage.vectorIndexDir);
    const backend = resolveBackend(this.config.storage.backend);
    const graphDbRuntime = backend === 'aira-graphdb';
    mkdirSync(dirname(sqlitePath), { recursive: true });
    if (backend === 'sqlite') {
      mkdirSync(vectorIndexDir, { recursive: true });
    }

    this.db = openDatabase(sqlitePath);
    if (this.config.storage.autoMigrate) {
      runMigrations(this.db);
    }

    let graphStore: IGraphStore;
    let vectorIndex: IVectorIndex;
    let memoryStore: IMemoryStore;
    let indexingMemory: IIndexingMemory;
    let graphProjection: IGraphProjection;
    let storageBatch: StorageAdapters['batch'];

    if (graphDbRuntime) {
      const storageAdapters: StorageAdapters = await createAiraGraphDbAdapters({
        dbPath: `${sqlitePath}.aira-graphdb.json`,
      });
      graphStore = storageAdapters.graphStore;
      vectorIndex = storageAdapters.vectorIndex;
      memoryStore = storageAdapters.memoryStore;
      indexingMemory = storageAdapters.indexingMemory;
      graphProjection = storageAdapters.graphProjection;
      storageBatch = storageAdapters.batch;
      this.storageClose = storageAdapters.close;
    } else {
      const sqliteGraphStore = new SQLiteGraphStore(this.db);
      graphStore = sqliteGraphStore;
      vectorIndex = new FileVectorIndex(vectorIndexDir);
      memoryStore = new SQLiteMemoryStore(this.db);
      indexingMemory = new SnapshotBackedIndexingMemory(memoryStore);
      graphProjection = new SQLiteGraphProjection(sqliteGraphStore);
      this.storageClose = undefined;
    }
    const sharedLexiconStore = new SQLiteLexiconStore(this.db, RUNTIME_CORPUS_ID);

    const apiKey = resolveApiKey(this.config.providers.apiKeyFile);

    const llmProvider: ILLMProvider = this.config.localOnly
      ? new FeatureUnavailableLLMProvider()
      : new OpenAILLMProvider({
        apiKey,
        model: this.config.providers.llm.model,
        baseUrl: process.env['OPENAI_BASE_URL'],
      });

    const embeddingProvider = createConfiguredEmbeddingProvider(this.config);

    const nlpExtractor: INLPExtractor = this.config.providers.nlp.backend === 'python-sidecar'
      ? new PythonSidecarExtractor({
        pythonCommand: this.config.providers.nlp.pythonCommand,
        requestTimeoutMs: this.config.providers.nlp.requestTimeoutMs,
        healthcheckTimeoutMs: this.config.providers.nlp.healthcheckTimeoutMs,
      })
      : new RegexExtractor();

    const deleteDocumentService = new DeleteDocumentService(this.db, graphStore, vectorIndex);
    const pipeline = this.config.localOnly
      ? new MinimalDocumentIndexingPipeline(this.db)
      : new FullDocumentIndexingPipeline({
        db: this.db,
        graphStore,
        vectorIndex,
        indexingMemory,
        llmProvider,
        embeddingProvider,
        nlpExtractor,
        ...(graphDbRuntime
          ? { enableDictionaryIndexing: false }
          : {
            enableDictionaryIndexing: true,
            dictionary: sharedLexiconStore as ITermDictionary,
            dictionaryFactory: (cid: string) => new SQLiteLexiconStore(this.db!, cid) as ITermDictionary,
          }),
      });
    const jobRunner = this.jobRunner = new AsyncJobRunner(
      this.db,
      memoryStore,
      pipeline,
      storageBatch,
    );
    const indexingService = new DefaultIndexingService(this.db, jobRunner, deleteDocumentService);
    const corpusManager = new CorpusManagerFacade(this.db, graphStore, vectorIndex);
    const dictionaryService = new DictionaryServiceFacade(this.db, this.config);
    const thesaurusService = new ThesaurusServiceFacade(this.db);
    const queryService = new QueryServiceFacade(this.db, llmProvider, embeddingProvider, vectorIndex, memoryStore, graphStore, graphProjection);

    this.services.set(SERVICE_TOKENS.GRAPH_STORE, graphStore);
    this.services.set(SERVICE_TOKENS.VECTOR_INDEX, vectorIndex);
    this.services.set(SERVICE_TOKENS.MEMORY_STORE, memoryStore);
    this.services.set(SERVICE_TOKENS.LLM_PROVIDER, llmProvider);
    this.services.set(SERVICE_TOKENS.EMBEDDING_PROVIDER, embeddingProvider);
    this.services.set(SERVICE_TOKENS.NLP_EXTRACTOR, nlpExtractor);
    this.services.set(SERVICE_TOKENS.TERM_DICTIONARY, sharedLexiconStore as ITermDictionary);
    this.services.set(SERVICE_TOKENS.THESAURUS, sharedLexiconStore as IThesaurus);
    this.services.set(SERVICE_TOKENS.CORPUS_MANAGER, corpusManager);
    this.services.set(SERVICE_TOKENS.INDEXING_SERVICE, indexingService);
    this.services.set(SERVICE_TOKENS.QUERY_SERVICE, queryService);
    this.services.set(SERVICE_TOKENS.DICTIONARY_SERVICE, dictionaryService);
    this.services.set(SERVICE_TOKENS.THESAURUS_SERVICE, thesaurusService);
    this.services.set(SERVICE_TOKENS.DB, this.db);

    this.started = true;
  }

  public async shutdown(): Promise<void> {
    if (!this.started) {
      return;
    }

    if (this.db) {
      // Cancel only jobs owned by THIS process. A global cancel here killed
      // other processes' running jobs whenever any CLI invocation exited.
      const owned = this.jobRunner?.ownedJobIds() ?? [];
      if (owned.length > 0) {
        const placeholders = owned.map(() => '?').join(',');
        this.db.prepare(
          `UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE job_id IN (${placeholders}) AND status IN ('pending', 'running')`,
        ).run(new Date().toISOString(), ...owned);
      }
    }

    const nlpExtractor = this.services.get(SERVICE_TOKENS.NLP_EXTRACTOR) as
      | (INLPExtractor & { shutdown?: () => Promise<void> | void })
      | undefined;
    if (nlpExtractor?.shutdown) {
      await nlpExtractor.shutdown();
    }

    if (this.storageClose) {
      await this.storageClose();
      this.storageClose = undefined;
    }

    this.db?.close();
    this.db = undefined;
    this.services.clear();
    this.started = false;
  }

  public getService<T>(token: symbol): T {
    const service = this.services.get(token);
    if (service === undefined) {
      throw new Error(`Service not registered for token ${String(token)}`);
    }
    return service as T;
  }
}

export function createMemGraphRagRuntime(config: MemGraphRagConfig): MemGraphRagRuntime {
  return new RuntimeImpl(config);
}
