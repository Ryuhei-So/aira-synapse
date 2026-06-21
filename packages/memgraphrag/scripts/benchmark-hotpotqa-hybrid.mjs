/**
 * HotpotQA Hybrid Benchmark:
 *   Graph/Vectors: aira-graphdb (fresh ingest)
 *   Dictionary/Thesaurus: SQLite (existing lexicon)
 *   Memory: configurable (SQLite or aira-graphdb)
 *
 * Purpose: Measure the impact of dictionary/thesaurus on accuracy
 *          when used with fresh aira-graphdb graph backend.
 *
 * Usage:
 *   node scripts/benchmark-hotpotqa-hybrid.mjs                    # SQLite memory + dict/thesaurus
 *   MEMORY=agdb node scripts/benchmark-hotpotqa-hybrid.mjs        # aira-graphdb memory + dict/thesaurus
 *   DICT=off node scripts/benchmark-hotpotqa-hybrid.mjs           # SQLite memory, no dict (control)
 *
 * Environment:
 *   OPENAI_API_KEY — required
 *   AGDB_PATH      — path to aira-graphdb file (default: /tmp/hotpotqa-fresh.agdb)
 *   MEMORY         — 'sqlite' (default) or 'agdb'
 *   DICT           — 'on' (default) or 'off'
 *   BENCH_SIZE     — 500 (default)
 *   CONCURRENCY    — query concurrency (default: 5)
 */
import { resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { loadMemGraphRagConfig, resolveConfigFromEnv, resolveApiKey } from '../dist/infrastructure/config/index.js';
import {
  SQLiteMemoryStore, SQLiteLexiconStore,
  CachedMemoryStore, CachedGraphProjection, CachedFileVectorIndex,
  openDatabase,
  AiraGraphDbNativeClient, AiraGraphDbGraphStore, AiraGraphDbGraphProjection,
  AiraGraphDbVectorIndex, AiraGraphDbMemoryStore,
  OpenAILLMProvider, OpenAIEmbeddingProvider,
} from '../dist/infrastructure/index.js';
import { DefaultQueryService } from '../dist/application/query/QueryService.js';
import { VectorMemoryFilter } from '../dist/application/query/VectorMemoryFilter.js';
import { SimpleNodeInitializer } from '../dist/application/query/SimpleNodeInitializer.js';
import { SimplePPR } from '../dist/application/query/SimplePPR.js';
import { SimpleContextBuilder } from '../dist/application/query/SimpleContextBuilder.js';
import { ThesaurusExpansionPolicy } from '../dist/application/index.js';

// ─── Config ────────────────────────────────────────────────────────────────────

const AGDB_PATH = process.env.AGDB_PATH || '/tmp/hotpotqa-fresh.agdb';
const AGDB_CORPUS_ID = process.env.AGDB_CORPUS_ID || 'hotpotqa-v2';
const SQLITE_PATH = resolve(process.cwd(), 'data/benchmark/hotpotqa/hotpotqa.sqlite');
const SQLITE_CORPUS_ID = 'fc0213c5-678c-4a79-aef9-c253b5f00c3d';
const VECTORS_DIR = resolve(process.cwd(), 'data/benchmark/hotpotqa/vectors');
const BENCH_SIZE = process.env.BENCH_SIZE || '500';
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '5');
const MEMORY_BACKEND = process.env.MEMORY || 'sqlite';
const DICT_ENABLED = (process.env.DICT || 'on') === 'on';

const BENCHMARK_DIR = resolve(process.cwd(), 'data/benchmark/hotpotqa');
const QUESTIONS_FILE = resolve(BENCHMARK_DIR, `benchmark_${BENCH_SIZE}.json`);

// ─── Helpers ───────────────────────────────────────────────────────────────────

function normalize(s) {
  return s.toLowerCase()
    .replace(/\b(a|an|the|is|are|was|were|be|been|do|does|did)\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizedContains(response, answer) {
  if (!response || !answer) return false;
  const nr = normalize(response);
  const na = normalize(answer);
  if (nr.includes(na)) return true;
  if (na.length <= 4) {
    return nr.split(/\s+/).some(w => w === na);
  }
  return false;
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const configPath = resolve(process.cwd(), 'config/default.memgraphrag.yml');
  const baseConfig = loadMemGraphRagConfig(configPath);
  const config = resolveConfigFromEnv(baseConfig);
  const apiKey = resolveApiKey(config.providers.apiKeyFile);

  // --- aira-graphdb backend (graph + vectors) ---
  const agdbClient = new AiraGraphDbNativeClient(AGDB_PATH);
  await agdbClient.request('ping');
  console.log(`[hybrid] aira-graphdb: ${AGDB_PATH}`);

  const graphStore = new AiraGraphDbGraphStore(agdbClient);
  const graphProjection = new CachedGraphProjection(new AiraGraphDbGraphProjection(agdbClient));
  const vectorIndex = new AiraGraphDbVectorIndex(agdbClient);

  // --- SQLite backend (dict/thesaurus, optionally memory) ---
  const db = openDatabase(SQLITE_PATH);
  console.log(`[hybrid] SQLite: ${SQLITE_PATH}`);

  // Dictionary + Thesaurus
  let dictionary, expansionPolicy;
  if (DICT_ENABLED) {
    dictionary = new SQLiteLexiconStore(db, SQLITE_CORPUS_ID);
    const thesaurus = new SQLiteLexiconStore(db, SQLITE_CORPUS_ID);
    expansionPolicy = new ThesaurusExpansionPolicy(thesaurus);
    console.log(`[hybrid] Dictionary: SQLite (76,727 terms)`);
    console.log(`[hybrid] Thesaurus: SQLite (3,426 relations)`);
  } else {
    dictionary = { match: () => [] };
    expansionPolicy = { expand: (terms) => terms };
    console.log(`[hybrid] Dictionary: DISABLED (noop)`);
    console.log(`[hybrid] Thesaurus: DISABLED (noop)`);
  }

  // Memory store
  // Note: SQLiteMemoryStore filters by corpusId, so we need to use the correct one.
  // Vector search goes to aira-graphdb (uses AGDB_CORPUS_ID).
  // We wrap the memory store to intercept the corpusId for SQLite.
  let memoryStore;
  if (MEMORY_BACKEND === 'agdb') {
    memoryStore = new CachedMemoryStore(new AiraGraphDbMemoryStore(agdbClient));
    console.log(`[hybrid] Memory: aira-graphdb`);
  } else {
    const sqliteMemory = new SQLiteMemoryStore(db);
    // Wrap to remap corpusId: query uses AGDB_CORPUS_ID but SQLite data is under SQLITE_CORPUS_ID
    const remappedMemory = {
      load: (corpusId) => sqliteMemory.load(corpusId === AGDB_CORPUS_ID ? SQLITE_CORPUS_ID : corpusId),
      save: (corpusId, snapshot) => sqliteMemory.save(corpusId === AGDB_CORPUS_ID ? SQLITE_CORPUS_ID : corpusId, snapshot),
    };
    memoryStore = new CachedMemoryStore(remappedMemory);
    console.log(`[hybrid] Memory: SQLite (154,855 facts, remapped corpusId)`);
  }

  const corpusId = AGDB_CORPUS_ID;

  // --- LLM + Embedding ---
  const llm = new OpenAILLMProvider({ apiKey, model: config.providers.llm.model });
  const embedding = new OpenAIEmbeddingProvider({
    apiKey,
    model: config.providers.embedding.model,
    dimensions: config.providers.embedding.dimensions,
  });

  // --- HyperParams ---
  const HP_HUB = parseInt(process.env.HP_HUB || '50');
  const HP_TOPK = parseInt(process.env.HP_TOPK || '10');
  const HP_TOPM = parseInt(process.env.HP_TOPM || '10');
  const HP_CTX = parseInt(process.env.HP_CTX || '3000');
  const HP_EFFORT = process.env.HP_EFFORT || 'high';
  const HP_VERBOSITY = process.env.HP_VERBOSITY || 'low';

  const hyperParams = {
    teleportProbability: 0.5,
    scTemperature: 0,
    scSamples: 1,
    hubDegreeThreshold: HP_HUB,
    reasoningEffort: HP_EFFORT,
    verbosity: HP_VERBOSITY,
  };

  const queryService = new DefaultQueryService({
    dictionary,
    expansionPolicy,
    memoryFilter: new VectorMemoryFilter(embedding, vectorIndex, memoryStore, graphStore),
    nodeInitializer: new SimpleNodeInitializer(memoryStore),
    ppr: new SimplePPR(HP_HUB),
    projection: graphProjection,
    contextBuilder: new SimpleContextBuilder(memoryStore),
    llm,
    hyperParams,
  });

  // --- Benchmark ---
  const questions = JSON.parse(readFileSync(QUESTIONS_FILE, 'utf-8'));
  const label = `dict=${DICT_ENABLED ? 'ON' : 'OFF'} memory=${MEMORY_BACKEND} graph=aira-graphdb`;
  console.log(`\n=== Hybrid Benchmark: ${questions.length} questions ===`);
  console.log(`  Config: ${label}`);
  console.log(`  HyperParams: hub=${HP_HUB} K=${HP_TOPK} M=${HP_TOPM} ctx=${HP_CTX} effort=${HP_EFFORT}`);

  const results = new Array(questions.length);
  let correct = 0, total = 0;
  const startTime = Date.now();

  for (let batchStart = 0; batchStart < questions.length; batchStart += CONCURRENCY) {
    const batchEnd = Math.min(batchStart + CONCURRENCY, questions.length);
    const batch = questions.slice(batchStart, batchEnd);

    const batchResults = await Promise.all(batch.map(async (q) => {
      try {
        const result = await queryService.query({
          corpusId,
          text: q.question,
          topK: HP_TOPK,
          topM: HP_TOPM,
          threshold: 0.2,
          contextTokenLimit: HP_CTX,
        });
        const isCorrect = normalizedContains(result.response, q.answer);
        return { id: q.id, question: q.question, goldAnswer: q.answer, type: q.type, response: result.response, correct: isCorrect };
      } catch (error) {
        return { id: q.id, question: q.question, goldAnswer: q.answer, type: q.type, response: null, correct: false, error: error.message };
      }
    }));

    for (let j = 0; j < batchResults.length; j++) {
      results[batchStart + j] = batchResults[j];
      total++;
      if (batchResults[j].correct) correct++;
    }

    if (total % 10 === 0 || batchEnd === questions.length) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const accuracy = ((correct / total) * 100).toFixed(1);
      console.log(`  [${total}/${questions.length}] Accuracy: ${accuracy}% (${correct}/${total}) | ${elapsed}s`);
    }
  }

  // --- Results ---
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(0);
  const accuracy = ((correct / total) * 100).toFixed(2);
  const byType = {};
  for (const r of results) {
    const t = r.type || 'unknown';
    byType[t] = byType[t] || { correct: 0, total: 0 };
    byType[t].total++;
    if (r.correct) byType[t].correct++;
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`HYBRID BENCHMARK RESULTS: HotpotQA ${BENCH_SIZE}`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Config: ${label}`);
  console.log(`Overall Accuracy (Str-Acc): ${accuracy}% (${correct}/${total})`);
  console.log(`Time: ${totalTime}s (${(totalTime / total).toFixed(1)}s/query)`);
  for (const [type, stats] of Object.entries(byType)) {
    console.log(`  ${type}: ${((stats.correct / stats.total) * 100).toFixed(1)}% (${stats.correct}/${stats.total})`);
  }

  const suffix = `hybrid_${DICT_ENABLED ? 'dict' : 'nodict'}_${MEMORY_BACKEND}`;
  const resultsFile = resolve(BENCHMARK_DIR, `results_${suffix}_${BENCH_SIZE}.json`);
  writeFileSync(resultsFile, JSON.stringify({
    summary: {
      accuracy: parseFloat(accuracy), correct, total, byType,
      timeSeconds: parseInt(totalTime),
      config: { dictionary: DICT_ENABLED, memory: MEMORY_BACKEND, graph: 'aira-graphdb-fresh' },
      timestamp: new Date().toISOString(),
    },
    results,
  }, null, 2));
  console.log(`\nResults saved to: ${resultsFile}`);

  db.close();
  await agdbClient.close();
}

main().catch(err => { console.error(err); process.exit(1); });
