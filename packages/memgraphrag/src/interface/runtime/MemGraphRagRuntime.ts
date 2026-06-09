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
  DefaultIndexingService,
  DefaultQueryService,
  DefaultThesaurusService,
  DeleteDocumentService,
  ThesaurusExpansionPolicy,
} from '../../application/index.js';
import { FullDocumentIndexingPipeline } from '../../application/indexing/FullDocumentIndexingPipeline.js';
import type {
  FilteredMemoryCandidates,
  IContextBuilder,
  IEmbeddingProvider,
  IGraphProjection,
  ILLMProvider,
  IMemoryFilter,
  INLPExtractor,
  INodeInitializer,
  IPPR,
  ITermDictionary,
  IThesaurus,
  NodeInitializationVector,
  QueryRequest,
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
  SemanticScholarCache,
  SemanticScholarClient,
  openDatabase,
  runMigrations,
} from '../../infrastructure/index.js';
import type { MemGraphRagConfig } from '../../infrastructure/config/index.js';
import { resolveApiKey } from '../../infrastructure/config/index.js';

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
} as const;

const RUNTIME_CORPUS_ID = '__runtime__';

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

class EmptyMemoryFilter implements IMemoryFilter {
  public async filter(): Promise<FilteredMemoryCandidates> {
    return {
      ontology: [],
      facts: [],
      passages: [],
      expandedTerms: [],
      fallbackRequired: false,
    };
  }
}

class EmptyNodeInitializer implements INodeInitializer {
  public async initialize(): Promise<NodeInitializationVector> {
    return { scores: {}, fallbackTriggered: false };
  }
}

class EmptyGraphProjection implements IGraphProjection {
  public async *getTransitions(): AsyncIterable<{ sourceNodeId: string; targetNodeId: string; weight: number }> {}
  public async getDanglingNodes(): Promise<readonly string[]> {
    return [];
  }
  public async getNodeCount(): Promise<number> {
    return 0;
  }
}

class EmptyPpr implements IPPR {
  public async run() {
    return {
      rankedPassages: [],
      rankedEntities: [],
      iterations: 0,
      converged: true,
      l1Delta: 0,
    };
  }
}

class EmptyContextBuilder implements IContextBuilder {
  public async build(_query: QueryRequest, _ranking: Awaited<ReturnType<IPPR['run']>>) {
    return {
      promptContext: '',
      citedPassages: [],
      citedFacts: [],
      confidence: 0,
    };
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
    private readonly graphStore: SQLiteGraphStore,
    private readonly vectorIndex: FileVectorIndex,
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
  ) {}

  public async query(request: QueryRequest): Promise<QueryResponse> {
    const dictionary = new SQLiteLexiconStore(this.db, request.corpusId);
    const thesaurus = new SQLiteLexiconStore(this.db, request.corpusId);
    const service = new DefaultQueryService({
      dictionary,
      expansionPolicy: new ThesaurusExpansionPolicy(thesaurus),
      memoryFilter: new EmptyMemoryFilter(),
      nodeInitializer: new EmptyNodeInitializer(),
      ppr: new EmptyPpr(),
      projection: new EmptyGraphProjection(),
      contextBuilder: new EmptyContextBuilder(),
      llm: this.llm,
    });
    return service.query(request);
  }
}

class RuntimeImpl implements MemGraphRagRuntime {
  private readonly services = new Map<symbol, unknown>();
  private db?: Database.Database;
  private started = false;

  public constructor(private readonly config: MemGraphRagConfig) {}

  public async start(): Promise<void> {
    if (this.started) {
      return;
    }

    const sqlitePath = resolve(process.cwd(), this.config.storage.sqlitePath);
    const vectorIndexDir = resolve(process.cwd(), this.config.storage.vectorIndexDir);
    mkdirSync(dirname(sqlitePath), { recursive: true });
    mkdirSync(vectorIndexDir, { recursive: true });

    this.db = openDatabase(sqlitePath);
    if (this.config.storage.autoMigrate) {
      runMigrations(this.db);
    }

    const graphStore = new SQLiteGraphStore(this.db);
    const vectorIndex = new FileVectorIndex(vectorIndexDir);
    const memoryStore = new SQLiteMemoryStore(this.db);
    const sharedLexiconStore = new SQLiteLexiconStore(this.db, RUNTIME_CORPUS_ID);

    const apiKey = resolveApiKey(this.config.providers.apiKeyFile);

    const llmProvider: ILLMProvider = this.config.localOnly
      ? new FeatureUnavailableLLMProvider()
      : new OpenAILLMProvider({
        apiKey,
        model: this.config.providers.llm.model,
      });

    const embeddingProvider: IEmbeddingProvider = this.config.localOnly
      ? new FeatureUnavailableEmbeddingProvider()
      : new OpenAIEmbeddingProvider({
        apiKey,
        model: this.config.providers.embedding.model,
      });

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
        memoryStore,
        llmProvider,
        embeddingProvider,
        nlpExtractor,
      });
    const jobRunner = new AsyncJobRunner(
      this.db,
      memoryStore,
      pipeline,
    );
    const indexingService = new DefaultIndexingService(this.db, jobRunner, deleteDocumentService);
    const corpusManager = new CorpusManagerFacade(this.db, graphStore, vectorIndex);
    const dictionaryService = new DictionaryServiceFacade(this.db, this.config);
    const thesaurusService = new ThesaurusServiceFacade(this.db);
    const queryService = new QueryServiceFacade(this.db, llmProvider);

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

    this.started = true;
  }

  public async shutdown(): Promise<void> {
    if (!this.started) {
      return;
    }

    if (this.db) {
      this.db.prepare(
        `UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE status IN ('pending', 'running')`,
      ).run(new Date().toISOString());
    }

    const nlpExtractor = this.services.get(SERVICE_TOKENS.NLP_EXTRACTOR) as
      | (INLPExtractor & { shutdown?: () => Promise<void> | void })
      | undefined;
    if (nlpExtractor?.shutdown) {
      await nlpExtractor.shutdown();
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
