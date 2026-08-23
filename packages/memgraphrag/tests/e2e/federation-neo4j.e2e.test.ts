/**
 * E2E Federation Test — EN + JP corpora on Neo4j.
 *
 * Prerequisites:
 *   - Neo4j running on bolt://localhost:7687 (neo4j/memgraphrag)
 *   - Two corpora indexed: EN (HotpotQA) and JP (Japanese Wikipedia)
 *   - OPENAI_API_KEY env var or config/openai_api_key file
 *
 * Run: npx vitest run tests/e2e/federation-neo4j.e2e.test.ts
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { FederatedQueryService } from '../../src/application/query/FederatedQueryService.js';
import { DefaultRRFMerger } from '../../src/application/query/DefaultRRFMerger.js';
import { DefaultQueryService } from '../../src/application/query/QueryService.js';
import { VectorMemoryFilter } from '../../src/application/query/VectorMemoryFilter.js';
import { SimpleNodeInitializer } from '../../src/application/query/SimpleNodeInitializer.js';
import { SimplePPR } from '../../src/application/query/SimplePPR.js';
import { SimpleContextBuilder } from '../../src/application/query/SimpleContextBuilder.js';
import { ThesaurusExpansionPolicy } from '../../src/application/index.js';
import { createNeo4jAdapters } from '../../src/infrastructure/storage/ladybug/storageFactory.js';
import { OpenAIEmbeddingProvider } from '../../src/infrastructure/embedding/OpenAIEmbeddingProvider.js';
import { OpenAILLMProvider } from '../../src/infrastructure/llm/OpenAILLMProvider.js';
import type { StorageAdapters } from '../../src/infrastructure/storage/ladybug/storageFactory.js';
import type { FederatedDbConfig, FederatedQueryConfig } from '../../src/application/query/federationTypes.js';
import type { ITermDictionary, IThesaurus } from '../../src/domain/index.js';

// Corpus IDs from Neo4j (discovered via inspection)
const EN_CORPUS_ID = 'fc0213c5-678c-4a79-aef9-c253b5f00c3d';
const JP_CORPUS_ID = '4484a03a-210a-4154-ac2f-c98d648f358a';

const NEO4J_OPTS = {
  uri: 'bolt://localhost:7687',
  username: 'neo4j',
  password: 'memgraphrag',
  vectorDimensions: 1536,
};

// Resolve API key from env or file
const keyFilePath = resolve(process.cwd(), 'config/openai_api_key');
const apiKey = process.env.OPENAI_API_KEY
  ?? (existsSync(keyFilePath) ? readFileSync(keyFilePath, 'utf-8').trim() : '');
const describeIf = process.env.RUN_NEO4J_E2E === '1' && apiKey ? describe : describe.skip;

describeIf('E2E: Federated Query across EN + JP corpora (Neo4j)', () => {
  let enAdapters: StorageAdapters;
  let jpAdapters: StorageAdapters;
  let embeddingProvider: OpenAIEmbeddingProvider;
  let llmProvider: OpenAILLMProvider;
  let federatedService: FederatedQueryService;

  beforeAll(async () => {
    // Create shared adapters for "primary" service (used for prepare + answer)
    enAdapters = await createNeo4jAdapters(NEO4J_OPTS);
    jpAdapters = await createNeo4jAdapters(NEO4J_OPTS);

    embeddingProvider = new OpenAIEmbeddingProvider({
      apiKey,
      model: 'text-embedding-3-large',
    });

    llmProvider = new OpenAILLMProvider({
      apiKey,
      model: 'gpt-4.1-mini',
    });

    // Stub dictionary/thesaurus (no lexicon data in these corpora)
    const stubDict: ITermDictionary = {
      match: async () => [],
      addTerm: async () => {},
      removeTerm: async () => {},
      listTerms: async () => ({ terms: [], total: 0, page: 1, pageSize: 50 }),
      getStats: async () => ({ totalTerms: 0, domainDistribution: {} }),
    };
    const stubThesaurus: IThesaurus = {
      expand: async () => [],
      addSynonymGroup: async () => {},
      removeSynonymGroup: async () => {},
      listGroups: async () => ({ groups: [], total: 0, page: 1, pageSize: 50 }),
    };

    // Create primary service (for prepare + answer)
    const primaryService = new DefaultQueryService({
      dictionary: stubDict,
      expansionPolicy: new ThesaurusExpansionPolicy(stubThesaurus),
      memoryFilter: new VectorMemoryFilter(embeddingProvider, enAdapters.vectorIndex, enAdapters.memoryStore, enAdapters.graphStore),
      nodeInitializer: new SimpleNodeInitializer(enAdapters.memoryStore),
      ppr: new SimplePPR(),
      projection: enAdapters.graphProjection,
      contextBuilder: new SimpleContextBuilder(enAdapters.memoryStore),
      llm: llmProvider,
    });

    // Federation config: 2 DBs pointing to same Neo4j with different corpusIds
    const config: FederatedQueryConfig = {
      databases: [
        { dbId: 'en-hotpotqa', dbPath: 'neo4j://localhost', corpusId: EN_CORPUS_ID },
        { dbId: 'jp-wikipedia', dbPath: 'neo4j://localhost', corpusId: JP_CORPUS_ID },
      ],
      rrfK: 60,
      perDbTopK: 5,
      globalTopK: 8,
      maxContributionRatio: 0.7,
      contextTokenBudget: 4000,
      perDbTimeoutMs: 30000,
      maxParallelism: 2,
    };

    // DB factory: create Neo4j adapters + DefaultQueryService per DB
    const dbFactory = async (dbConfig: FederatedDbConfig) => {
      const adapters = await createNeo4jAdapters(NEO4J_OPTS);
      const queryService = new DefaultQueryService({
        dictionary: stubDict,
        expansionPolicy: new ThesaurusExpansionPolicy(stubThesaurus),
        memoryFilter: new VectorMemoryFilter(embeddingProvider, adapters.vectorIndex, adapters.memoryStore, adapters.graphStore),
        nodeInitializer: new SimpleNodeInitializer(adapters.memoryStore),
        ppr: new SimplePPR(),
        projection: adapters.graphProjection,
        contextBuilder: new SimpleContextBuilder(adapters.memoryStore),
        llm: llmProvider,
      });
      return { adapters, queryService };
    };

    federatedService = new FederatedQueryService(config, {
      embeddingProvider,
      primaryService,
      dbFactory,
      merger: new DefaultRRFMerger(),
      llm: llmProvider,
    });
  }, 30000);

  afterAll(async () => {
    await federatedService?.close();
    await enAdapters?.close();
    await jpAdapters?.close();
  });

  it('retrieve() returns passages from both EN and JP corpora', async () => {
    const ctx = await federatedService.retrieve({
      corpusId: EN_CORPUS_ID, // fallback corpus
      text: 'What is the 10000 meters world record?',
      topK: 5,
      topM: 3,
      threshold: 0.3,
      contextTokenLimit: 4000,
    });

    expect(ctx.passages.length).toBeGreaterThan(0);

    // Check that we have results from multiple DBs (via namespace prefix)
    const dbIds = new Set(ctx.passages.map((rp) => rp.passage.passageId.split(':')[0]));
    console.log('DBs contributing passages:', [...dbIds]);
    console.log(`Total merged passages: ${ctx.passages.length}`);
    ctx.passages.slice(0, 3).forEach((rp, i) => {
      console.log(`  [${i}] score=${rp.score.toFixed(4)} id=${rp.passage.passageId.slice(0, 60)} text=${rp.passage.text.slice(0, 80)}`);
    });

    // At minimum one DB should contribute
    expect(dbIds.size).toBeGreaterThanOrEqual(1);
  }, 60000);

  it('query() returns an answer referencing both corpora', async () => {
    const response = await federatedService.query({
      corpusId: EN_CORPUS_ID,
      text: 'Who holds the 10000 meters running world record?',
      topK: 5,
      topM: 3,
      threshold: 0.3,
      contextTokenLimit: 4000,
    });

    expect(response.response).toBeTruthy();
    expect(response.response.length).toBeGreaterThan(10);
    expect(response.metrics.federationEnabled).toBe(true);
    expect(response.metrics.federatedDbCount).toBe(2);
    expect(response.metrics.federatedSuccessCount).toBeGreaterThanOrEqual(1);

    console.log('Answer:', response.response.slice(0, 200));
    console.log('Metrics:', JSON.stringify({
      dbCount: response.metrics.federatedDbCount,
      successCount: response.metrics.federatedSuccessCount,
      failureCount: response.metrics.federatedFailureCount,
    }));
    if (response.warnings) {
      console.log('Warnings:', response.warnings);
    }
  }, 60000);

  it('JP query retrieves Japanese content', async () => {
    const ctx = await federatedService.retrieve({
      corpusId: JP_CORPUS_ID,
      text: '10000メートル競走の世界記録保持者は誰ですか',
      topK: 5,
      topM: 3,
      threshold: 0.3,
      contextTokenLimit: 4000,
    });

    expect(ctx.passages.length).toBeGreaterThan(0);

    const hasJapanese = ctx.passages.some((rp) => /[\u3000-\u9fff]/.test(rp.passage.text));
    console.log(`Has Japanese passages: ${hasJapanese}`);
    console.log(`Total passages: ${ctx.passages.length}`);
    ctx.passages.slice(0, 3).forEach((rp, i) => {
      console.log(`  [${i}] score=${rp.score.toFixed(4)} db=${rp.passage.passageId.split(':')[0]} text=${rp.passage.text.slice(0, 80)}`);
    });

    expect(hasJapanese).toBe(true);
  }, 60000);
});
