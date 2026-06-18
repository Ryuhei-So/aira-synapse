/**
 * HotpotQA Japanese Benchmark — LadybugDB Backend
 *
 * Orchestrates the full Japanese benchmark pipeline:
 *   translate → fetch → index → query
 *
 * Usage:
 *   node scripts/benchmark-hotpotqa-ja.mjs translate  # Translate EN→JA
 *   node scripts/benchmark-hotpotqa-ja.mjs fetch      # Fetch JA Wikipedia
 *   node scripts/benchmark-hotpotqa-ja.mjs query      # Run benchmark
 *   node scripts/benchmark-hotpotqa-ja.mjs all        # Full pipeline
 *
 * Environment:
 *   OPENAI_API_KEY — required
 *   BENCH_SIZE — 500 (default)
 *   CONCURRENCY — query concurrency (default: 5)
 *   NUM_QUESTIONS — limit questions (0 = all)
 */
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { loadMemGraphRagConfig, resolveConfigFromEnv, resolveApiKey } from '../dist/infrastructure/config/index.js';
import {
  SQLiteMemoryStore, SQLiteLexiconStore,
  OpenAILLMProvider, OpenAIEmbeddingProvider,
  CachedMemoryStore, CachedGraphProjection, CachedFileVectorIndex,
  openDatabase,
} from '../dist/infrastructure/index.js';
import { LadybugConnectionPool } from '../dist/infrastructure/storage/ladybug/LadybugConnection.js';
import { LadybugGraphStore } from '../dist/infrastructure/storage/ladybug/LadybugGraphStore.js';
import { LadybugGraphProjection } from '../dist/infrastructure/storage/ladybug/LadybugGraphProjection.js';
import { DefaultQueryService } from '../dist/application/query/QueryService.js';
import { VectorMemoryFilter } from '../dist/application/query/VectorMemoryFilter.js';
import { SimpleNodeInitializer } from '../dist/application/query/SimpleNodeInitializer.js';
import { SimplePPR } from '../dist/application/query/SimplePPR.js';
import { SimpleContextBuilder } from '../dist/application/query/SimpleContextBuilder.js';
import { ThesaurusExpansionPolicy } from '../dist/application/index.js';
import { V15_BASELINE_QUERY_FLAGS } from '../dist/domain/config/featureFlags.js';
import { normalizeJapanese, normalizedContainsJa } from './ja-eval-normalizer.mjs';

// ─── Paths ───
const REPO_ROOT = resolve(process.cwd(), '../..');
const BENCHMARK_DIR = resolve(REPO_ROOT, 'data/benchmark/hotpotqa-ja');
const LADYBUG_DB_PATH = resolve(BENCHMARK_DIR, 'hotpotqa-ja.lbug');
const SQLITE_PATH = resolve(BENCHMARK_DIR, 'hotpotqa-ja.sqlite');
const VECTORS_DIR = resolve(BENCHMARK_DIR, 'vectors');
const BENCH_SIZE = process.env.BENCH_SIZE || '500';
const QUESTIONS_FILE = resolve(BENCHMARK_DIR, `hotpotqa_ja_${BENCH_SIZE}.json`);
const RESULTS_FILE = resolve(BENCHMARK_DIR, `results_ja_${BENCH_SIZE}.json`);
const PHASE = process.argv[2] || 'query';

// ─── English eval (reuse from original benchmark) ───
// Inline the core normalizedContains for English fallback
function normalizeAnswer(s) {
  return s.toLowerCase().replace(/\b(a|an|the)\b/g, ' ').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

function normalizedContainsEn(response, goldAnswer) {
  if (!response || !goldAnswer) return false;
  const cleanResp = response.replace(/\*\*/g, '');
  const normResp = normalizeAnswer(cleanResp);
  const normGold = normalizeAnswer(goldAnswer);
  if (normResp.includes(normGold)) return true;
  if (normGold.includes(normResp) && normResp.length >= 3) return true;
  const goldTokens = normGold.split(' ').filter(t => t.length > 1);
  if (goldTokens.length >= 2) {
    const respTokens = new Set(normResp.split(' '));
    const matched = goldTokens.filter(t => respTokens.has(t)).length;
    if (matched >= goldTokens.length * 0.8) return true;
  }
  return false;
}

// ─── Translate phase ───
async function runTranslate() {
  console.log('=== Phase: Translate EN→JA ===');
  const scriptPath = resolve(process.cwd(), 'scripts/translate-hotpotqa.mjs');
  execSync(`node ${scriptPath}`, { stdio: 'inherit', env: { ...process.env } });
}

// ─── Fetch phase ───
async function runFetch() {
  console.log('=== Phase: Fetch JA Wikipedia ===');
  const scriptPath = resolve(process.cwd(), 'scripts/fetch-ja-wikipedia.mjs');
  execSync(`node ${scriptPath}`, { stdio: 'inherit', env: { ...process.env } });
}

// ─── Query phase ───
async function evaluateQueries() {
  if (!existsSync(QUESTIONS_FILE)) {
    console.error(`Error: ${QUESTIONS_FILE} not found. Run 'translate' and 'fetch' first.`);
    process.exit(1);
  }

  const CORPUS_ID = existsSync(resolve(BENCHMARK_DIR, 'corpus_id.txt'))
    ? readFileSync(resolve(BENCHMARK_DIR, 'corpus_id.txt'), 'utf-8').trim()
    : 'hotpotqa-ja';

  console.log('=== HotpotQA Japanese Benchmark — LadybugDB ===');
  console.log(`Corpus: ${CORPUS_ID}`);
  console.log(`Questions: ${QUESTIONS_FILE}`);

  const configPath = resolve(REPO_ROOT, 'packages/memgraphrag/config/hotpotqa-ja.memgraphrag.yml');
  const baseConfig = loadMemGraphRagConfig(configPath);
  const config = resolveConfigFromEnv(baseConfig);
  const apiKey = resolveApiKey(config.providers.apiKeyFile);

  // LadybugDB for graph operations
  const pool = new LadybugConnectionPool(LADYBUG_DB_PATH);
  await pool.init();
  const lbGraphStore = new LadybugGraphStore(pool);
  const graphProjection = new CachedGraphProjection(new LadybugGraphProjection(lbGraphStore));

  // SQLite for memory and lexicon
  const db = openDatabase(SQLITE_PATH);
  const memoryStore = new CachedMemoryStore(new SQLiteMemoryStore(db));
  const dictionary = new SQLiteLexiconStore(db, CORPUS_ID);
  const thesaurus = new SQLiteLexiconStore(db, CORPUS_ID);

  const vectorIndex = new CachedFileVectorIndex(VECTORS_DIR);

  const llm = new OpenAILLMProvider({ apiKey, model: config.providers.llm.model });
  const embedding = new OpenAIEmbeddingProvider({ apiKey, model: config.providers.embedding.model });

  const HP_HUB = parseInt(process.env.HP_HUB || '50');
  const HP_TP = parseFloat(process.env.HP_TP || '0.5');
  const HP_TOPK = parseInt(process.env.HP_TOPK || '10');
  const HP_TOPM = parseInt(process.env.HP_TOPM || '10');
  const HP_CTX = parseInt(process.env.HP_CTX || '3000');
  const HP_EFFORT = process.env.HP_EFFORT || 'high';
  const HP_VERBOSITY = process.env.HP_VERBOSITY || 'low';

  const hyperParams = {
    teleportProbability: HP_TP,
    scTemperature: 0.0,
    scSamples: 1,
    hubDegreeThreshold: HP_HUB,
    reasoningEffort: HP_EFFORT,
    verbosity: HP_VERBOSITY,
  };

  const featureFlags = V15_BASELINE_QUERY_FLAGS;

  const nodeInitializer = new SimpleNodeInitializer(memoryStore);
  const contextBuilder = new SimpleContextBuilder(memoryStore);
  const expansionPolicy = new ThesaurusExpansionPolicy(thesaurus, { synonymLimit: 3, hypernymLimit: 0 });
  const ppr = new SimplePPR(HP_HUB);

  const queryService = new DefaultQueryService({
    dictionary,
    expansionPolicy,
    memoryFilter: new VectorMemoryFilter(embedding, vectorIndex, memoryStore, null),
    nodeInitializer,
    ppr,
    projection: graphProjection,
    contextBuilder,
    llm,
    hyperParams,
    featureFlags,
  });

  // Load and filter questions (skip ja_coverage: false)
  const allQuestions = JSON.parse(readFileSync(QUESTIONS_FILE, 'utf-8'));
  const NUM_Q = parseInt(process.env.NUM_QUESTIONS || '0');
  const filteredAll = allQuestions.filter(q => q.ja_coverage !== false);
  const questions = NUM_Q > 0 ? filteredAll.slice(0, NUM_Q) : filteredAll;

  const skipped = allQuestions.length - filteredAll.length;
  const results = new Array(questions.length);
  let correct = 0, total = 0;
  const startTime = Date.now();
  const CONCURRENCY = parseInt(process.env.CONCURRENCY || '5');

  console.log(`\n=== Evaluating ${questions.length} Japanese queries (${skipped} skipped for no JA coverage) ===`);
  console.log(`  HyperParams: tp=${HP_TP} hub=${HP_HUB} K=${HP_TOPK} M=${HP_TOPM} ctx=${HP_CTX}`);
  console.log(`  Concurrency: ${CONCURRENCY}`);

  for (let batchStart = 0; batchStart < questions.length; batchStart += CONCURRENCY) {
    const batchEnd = Math.min(batchStart + CONCURRENCY, questions.length);
    const batch = questions.slice(batchStart, batchEnd);

    const batchResults = await Promise.all(batch.map(async (q) => {
      try {
        // Query in Japanese
        const queryText = q.question_ja || q.question;
        const result = await queryService.query({
          corpusId: CORPUS_ID,
          text: queryText,
          topK: HP_TOPK,
          topM: HP_TOPM,
          threshold: 0.2,
          contextTokenLimit: HP_CTX,
        });

        // Evaluate with Japanese-aware matching
        const isCorrect = normalizedContainsJa(
          result.response,
          q.answer_ja,
          q.answer,
          normalizedContainsEn,
        );

        return {
          id: q.id,
          question_ja: q.question_ja,
          question_en: q.question,
          goldAnswer_ja: q.answer_ja,
          goldAnswer_en: q.answer,
          type: q.type,
          response: result.response,
          correct: isCorrect,
          metrics: result.metrics,
          citationCount: result.citations.length,
        };
      } catch (error) {
        return {
          id: q.id,
          question_ja: q.question_ja,
          question_en: q.question,
          goldAnswer_ja: q.answer_ja,
          goldAnswer_en: q.answer,
          type: q.type,
          response: null,
          correct: false,
          error: error.message,
        };
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

  // Summary
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
  console.log(`BENCHMARK RESULTS: HotpotQA Japanese ${BENCH_SIZE}`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Overall Accuracy (Str-Acc): ${accuracy}% (${correct}/${total})`);
  console.log(`Skipped (no JA coverage): ${skipped}`);
  console.log(`Time: ${totalTime}s (${(totalTime / total).toFixed(1)}s/query)`);
  for (const [type, stats] of Object.entries(byType)) {
    console.log(`  ${type}: ${((stats.correct / stats.total) * 100).toFixed(1)}% (${stats.correct}/${stats.total})`);
  }

  const summary = {
    benchmark: 'HotpotQA-JA',
    backend: 'ladybug',
    language: 'ja',
    sampleSize: total,
    accuracy: parseFloat(accuracy),
    correct,
    total,
    skipped,
    timeSeconds: parseInt(totalTime),
    byType,
    featureFlags,
    timestamp: new Date().toISOString(),
  };

  writeFileSync(RESULTS_FILE, JSON.stringify({ summary, results }, null, 2));
  console.log(`\nResults saved to: ${RESULTS_FILE}`);

  await pool.close();
  db.close();

  return summary;
}

// ─── Main ───
async function main() {
  if (PHASE === 'translate' || PHASE === 'all') {
    await runTranslate();
  }
  if (PHASE === 'fetch' || PHASE === 'all') {
    await runFetch();
  }
  if (PHASE === 'query' || PHASE === 'all') {
    await evaluateQueries();
  }
}

main().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
