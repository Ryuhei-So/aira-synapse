/**
 * Oracle Recall Diagnostic — T-003
 *
 * Runs retrieval-only PPR (no LLM) for 50 known errors and computes
 * Recall@K (strict/lenient) against HotpotQA supporting_facts titles.
 *
 * "Recall" = what fraction of gold supporting_fact titles appear in
 * the top-K PPR passage results (matched by title substring).
 *
 * Usage:
 *   node scripts/oracle-recall-diagnostic.mjs
 *
 * Environment:
 *   RECALL_K — comma-separated K values (default: "10,20,50")
 *   CONCURRENCY — query concurrency (default: 5)
 *
 * Output:
 *   data/benchmark/hotpotqa/oracle_recall_report.json
 */
import { resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { loadMemGraphRagConfig, resolveConfigFromEnv, resolveApiKey } from '../dist/infrastructure/config/index.js';
import {
  SQLiteMemoryStore, SQLiteLexiconStore,
  OpenAIEmbeddingProvider,
  CachedMemoryStore, CachedGraphProjection, CachedFileVectorIndex,
  openDatabase,
} from '../dist/infrastructure/index.js';
import { LadybugConnectionPool } from '../dist/infrastructure/storage/ladybug/LadybugConnection.js';
import { LadybugGraphStore } from '../dist/infrastructure/storage/ladybug/LadybugGraphStore.js';
import { LadybugGraphProjection } from '../dist/infrastructure/storage/ladybug/LadybugGraphProjection.js';
import { VectorMemoryFilter } from '../dist/application/query/VectorMemoryFilter.js';
import { SimpleNodeInitializer } from '../dist/application/query/SimpleNodeInitializer.js';
import { SimplePPR } from '../dist/application/query/SimplePPR.js';

// ─── Paths ───
const REPO_ROOT = resolve(process.cwd(), '../..');
const BENCHMARK_DIR = resolve(REPO_ROOT, 'data/benchmark/hotpotqa');
const LADYBUG_DB_PATH = process.env.LADYBUG_DB_PATH
  ? resolve(process.cwd(), process.env.LADYBUG_DB_PATH)
  : resolve(BENCHMARK_DIR, 'hotpotqa.lbug');
const SQLITE_PATH = process.env.SQLITE_PATH
  ? resolve(process.cwd(), process.env.SQLITE_PATH)
  : resolve(BENCHMARK_DIR, 'hotpotqa.sqlite');
const VECTORS_DIR = resolve(BENCHMARK_DIR, 'vectors');
const QUESTIONS_FILE = resolve(BENCHMARK_DIR, 'benchmark_500.json');
const KNOWN_ERRORS_FILE = resolve(BENCHMARK_DIR, 'known_errors_v15.json');
const OUTPUT_FILE = resolve(BENCHMARK_DIR, 'oracle_recall_report.json');
const CORPUS_ID = readFileSync(resolve(BENCHMARK_DIR, 'corpus_id.txt'), 'utf-8').trim();

// ─── Config ───
const RECALL_K_VALUES = (process.env.RECALL_K || '10,20,50').split(',').map(Number);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '5');

function normalizeTitle(s) {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Strict match: passage title === supporting_fact title (normalized)
 */
function strictMatch(passageTitle, goldTitle) {
  return normalizeTitle(passageTitle) === normalizeTitle(goldTitle);
}

/**
 * Lenient match: one contains the other (normalized)
 */
function lenientMatch(passageTitle, goldTitle) {
  const normP = normalizeTitle(passageTitle);
  const normG = normalizeTitle(goldTitle);
  return normP.includes(normG) || normG.includes(normP);
}

async function main() {
  console.log('=== Oracle Recall Diagnostic ===');
  console.log(`Recall@K values: ${RECALL_K_VALUES.join(', ')}`);

  // Load questions and known errors
  const allQuestions = JSON.parse(readFileSync(QUESTIONS_FILE, 'utf-8'));
  const knownErrors = JSON.parse(readFileSync(KNOWN_ERRORS_FILE, 'utf-8'));

  // Build lookup: questionId → { question, supporting_facts }
  const questionMap = new Map();
  for (const q of allQuestions) {
    questionMap.set(q.id, q);
  }

  // Filter to 50 known errors that have supporting_facts
  const errorQuestions = knownErrors.errors
    .map(e => ({ ...e, fullQuestion: questionMap.get(e.questionId) }))
    .filter(e => e.fullQuestion && e.fullQuestion.supporting_facts);

  console.log(`Known errors with supporting_facts: ${errorQuestions.length}/${knownErrors.errors.length}`);

  // Infrastructure setup
  const configPath = resolve(REPO_ROOT, 'packages/memgraphrag/config/default.memgraphrag.yml');
  const baseConfig = loadMemGraphRagConfig(configPath);
  const config = resolveConfigFromEnv(baseConfig);
  const apiKey = resolveApiKey(config.providers.apiKeyFile);

  const pool = new LadybugConnectionPool(LADYBUG_DB_PATH);
  await pool.init();
  const lbGraphStore = new LadybugGraphStore(pool);
  const graphProjection = new CachedGraphProjection(new LadybugGraphProjection(lbGraphStore));

  const db = openDatabase(SQLITE_PATH);
  const memoryStore = new CachedMemoryStore(new SQLiteMemoryStore(db));

  const vectorIndex = new CachedFileVectorIndex(VECTORS_DIR);
  const embedding = new OpenAIEmbeddingProvider({
    apiKey,
    model: config.providers.embedding.model,
  });

  const memoryFilter = new VectorMemoryFilter(embedding, vectorIndex, memoryStore, null);
  const nodeInitializer = new SimpleNodeInitializer(memoryStore);
  const ppr = new SimplePPR(50);

  const maxK = Math.max(...RECALL_K_VALUES);
  const startTime = Date.now();

  // Run retrieval for each error question
  const perQuestion = [];

  for (let batchStart = 0; batchStart < errorQuestions.length; batchStart += CONCURRENCY) {
    const batch = errorQuestions.slice(batchStart, batchStart + CONCURRENCY);

    const batchResults = await Promise.all(batch.map(async (errQ) => {
      const q = errQ.fullQuestion;
      const goldTitles = q.supporting_facts.title || [];

      try {
        const request = {
          corpusId: CORPUS_ID,
          text: q.question,
          topK: maxK,
          topM: maxK,
          threshold: 0.2,
          contextTokenLimit: 5000,
        };
        const candidates = await memoryFilter.filter(request);
        const initResult = await nodeInitializer.initialize({ query: request, candidates });
        const ranking = await ppr.run({
          corpusId: CORPUS_ID,
          initialVector: initResult,
          teleportProbability: 0.5,
          convergenceEpsilon: 1e-6,
          maxIterations: 100,
          topK: maxK,
          topM: maxK,
        }, graphProjection);

        // Get passage titles from ranking
        const rankedPassages = ranking.rankedPassages || [];
        const passageTitles = [];
        for (const p of rankedPassages) {
          const passage = await memoryStore.getPassage(p.nodeId);
          if (passage) {
            passageTitles.push(passage.metadata?.title || '');
          }
        }

        // Compute recall at each K
        const recallAtK = {};
        for (const k of RECALL_K_VALUES) {
          const topKTitles = passageTitles.slice(0, k);
          const strictHits = goldTitles.filter(gt =>
            topKTitles.some(pt => strictMatch(pt, gt))
          );
          const lenientHits = goldTitles.filter(gt =>
            topKTitles.some(pt => lenientMatch(pt, gt))
          );
          recallAtK[k] = {
            strict: goldTitles.length > 0 ? strictHits.length / goldTitles.length : 0,
            lenient: goldTitles.length > 0 ? lenientHits.length / goldTitles.length : 0,
            strictHits: strictHits.length,
            lenientHits: lenientHits.length,
            goldCount: goldTitles.length,
          };
        }

        return {
          questionId: errQ.questionId,
          category: errQ.category,
          type: errQ.type,
          question: q.question,
          goldTitles,
          retrievedTitles: passageTitles.slice(0, 20),
          recallAtK,
          error: null,
        };
      } catch (error) {
        return {
          questionId: errQ.questionId,
          category: errQ.category,
          type: errQ.type,
          question: q.question,
          goldTitles: q.supporting_facts.title || [],
          retrievedTitles: [],
          recallAtK: Object.fromEntries(RECALL_K_VALUES.map(k => [k, { strict: 0, lenient: 0, strictHits: 0, lenientHits: 0, goldCount: 0 }])),
          error: error.message,
        };
      }
    }));

    perQuestion.push(...batchResults);
    const done = Math.min(batchStart + CONCURRENCY, errorQuestions.length);
    if (done % 10 === 0 || done === errorQuestions.length) {
      console.log(`  [${done}/${errorQuestions.length}] processed`);
    }
  }

  // Aggregate by category and overall
  const categories = ['retrieval', 'expression', 'yesno', 'generic', 'spelling'];
  const aggregated = {};

  for (const k of RECALL_K_VALUES) {
    aggregated[`recall@${k}`] = { overall: { strict: 0, lenient: 0, count: 0 } };
    for (const cat of categories) {
      aggregated[`recall@${k}`][cat] = { strict: 0, lenient: 0, count: 0 };
    }
  }

  for (const pq of perQuestion) {
    for (const k of RECALL_K_VALUES) {
      const r = pq.recallAtK[k];
      aggregated[`recall@${k}`].overall.strict += r.strict;
      aggregated[`recall@${k}`].overall.lenient += r.lenient;
      aggregated[`recall@${k}`].overall.count++;
      if (aggregated[`recall@${k}`][pq.category]) {
        aggregated[`recall@${k}`][pq.category].strict += r.strict;
        aggregated[`recall@${k}`][pq.category].lenient += r.lenient;
        aggregated[`recall@${k}`][pq.category].count++;
      }
    }
  }

  // Compute averages
  const summary = {};
  for (const k of RECALL_K_VALUES) {
    summary[`recall@${k}`] = {};
    for (const [group, stats] of Object.entries(aggregated[`recall@${k}`])) {
      if (stats.count > 0) {
        summary[`recall@${k}`][group] = {
          strict: parseFloat((stats.strict / stats.count * 100).toFixed(1)),
          lenient: parseFloat((stats.lenient / stats.count * 100).toFixed(1)),
          count: stats.count,
        };
      }
    }
  }

  // Phase 2b gate: retrieval category lenient Recall@20 > 50%
  const retrievalRecall20 = summary['recall@20']?.retrieval?.lenient || 0;
  const retrievalCount = summary['recall@20']?.retrieval?.count || 0;
  const phase2bGate = retrievalRecall20 > 50;

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(0);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`ORACLE RECALL DIAGNOSTIC REPORT`);
  console.log(`${'='.repeat(60)}`);
  for (const k of RECALL_K_VALUES) {
    console.log(`\nRecall@${k}:`);
    for (const [group, stats] of Object.entries(summary[`recall@${k}`])) {
      console.log(`  ${group}: strict=${stats.strict}% lenient=${stats.lenient}% (n=${stats.count})`);
    }
  }
  console.log(`\n--- Phase 2b Gate ---`);
  console.log(`Retrieval Recall@20 (lenient): ${retrievalRecall20}% (n=${retrievalCount})`);
  console.log(`Gate: ${phase2bGate ? 'PROCEED ✅' : 'SKIP ❌'} (threshold: >50%)`);
  console.log(`Time: ${totalTime}s`);

  const report = {
    diagnostic: 'oracle-recall',
    version: knownErrors.version,
    recallKValues: RECALL_K_VALUES,
    summary,
    phase2bGate: {
      metric: 'retrieval-lenient-recall@20',
      value: retrievalRecall20,
      threshold: 50,
      decision: phase2bGate ? 'proceed' : 'skip',
    },
    perQuestion,
    timeSeconds: parseInt(totalTime),
    timestamp: new Date().toISOString(),
  };

  writeFileSync(OUTPUT_FILE, JSON.stringify(report, null, 2));
  console.log(`\nReport saved to: ${OUTPUT_FILE}`);

  await pool.close();
  db.close();
}

main().catch(err => {
  console.error('Oracle Recall diagnostic failed:', err);
  process.exit(1);
});
