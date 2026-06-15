/**
 * HotpotQA Benchmark — LadybugDB Backend (Hybrid)
 *
 * Uses LadybugDB for graph operations (PPR, projection, traversal) and
 * keeps FileVectorIndex + SQLiteMemoryStore for data-intensive lookups.
 * This validates the LadybugDB graph path without impractical 113K-fact migration.
 *
 * Usage:
 *   node scripts/benchmark-hotpotqa-ladybug.mjs migrate   # Migrate graph to LadybugDB
 *   node scripts/benchmark-hotpotqa-ladybug.mjs query     # Run 500 queries
 *   node scripts/benchmark-hotpotqa-ladybug.mjs all       # Migrate + query
 *
 * Environment:
 *   OPENAI_API_KEY — required for query phase
 *   BENCH_SIZE — 500 (default) or 1000
 *   CONCURRENCY — query concurrency (default: 5)
 */
import { resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { loadMemGraphRagConfig, resolveConfigFromEnv, resolveApiKey } from '../dist/infrastructure/config/index.js';
import {
  SQLiteGraphStore, SQLiteMemoryStore, SQLiteLexiconStore,
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

// ─── Paths ───
// Benchmark data lives at repo root, not package root
const REPO_ROOT = resolve(process.cwd(), '../..');
const BENCHMARK_DIR = resolve(REPO_ROOT, 'data/benchmark/hotpotqa');
const LADYBUG_DB_PATH = resolve(BENCHMARK_DIR, 'hotpotqa.lbug');
const SQLITE_PATH = resolve(BENCHMARK_DIR, 'hotpotqa.sqlite');
const VECTORS_DIR = resolve(BENCHMARK_DIR, 'vectors');
const BENCH_SIZE = process.env.BENCH_SIZE || '500';
const QUESTIONS_FILE = process.env.QUESTIONS_FILE
  ? resolve(process.cwd(), process.env.QUESTIONS_FILE)
  : resolve(BENCHMARK_DIR, `benchmark_${BENCH_SIZE}.json`);
const RESULTS_FILE = resolve(BENCHMARK_DIR, `results_ladybug_${BENCH_SIZE}.json`);
const PHASE = process.argv[2] || 'all';
const CORPUS_ID = readFileSync(resolve(BENCHMARK_DIR, 'corpus_id.txt'), 'utf-8').trim();

// ─── Accuracy helpers (same as SQLite benchmark) ───
const NICKNAME_MAP = {
  'bill': 'william', 'bob': 'robert', 'dick': 'richard', 'ted': 'theodore',
  'mike': 'michael', 'jim': 'james', 'joe': 'joseph', 'tom': 'thomas',
  'tony': 'anthony', 'al': 'albert', 'ed': 'edward', 'dan': 'daniel',
  'ben': 'benjamin', 'chuck': 'charles', 'jack': 'john', 'jerry': 'gerald',
  'larry': 'lawrence', 'rick': 'richard', 'steve': 'stephen', 'will': 'william',
  'liz': 'elizabeth', 'beth': 'elizabeth', 'kate': 'katherine', 'sue': 'susan',
  'peggy': 'margaret', 'maggie': 'margaret', 'meg': 'margaret',
};
const COUNTRY_ALIASES = [
  ['usa', 'united states', 'united states of america', 'us', 'america'],
  ['uk', 'united kingdom', 'great britain', 'britain', 'england'],
  ['ussr', 'soviet union'],
  ['prc', 'peoples republic of china', 'china'],
  ['south korea', 'republic of korea', 'korea'],
  ['north korea', 'democratic peoples republic of korea', 'dprk'],
];
const DEMONYM_MAP = {
  'american': 'united states', 'british': 'united kingdom', 'english': 'england',
  'scottish': 'scotland', 'welsh': 'wales', 'irish': 'ireland',
  'french': 'france', 'german': 'germany', 'italian': 'italy', 'spanish': 'spain',
  'portuguese': 'portugal', 'dutch': 'netherlands', 'belgian': 'belgium',
  'swiss': 'switzerland', 'austrian': 'austria', 'swedish': 'sweden',
  'norwegian': 'norway', 'danish': 'denmark', 'finnish': 'finland',
  'polish': 'poland', 'russian': 'russia', 'chinese': 'china',
  'japanese': 'japan', 'korean': 'korea', 'indian': 'india',
  'australian': 'australia', 'canadian': 'canada', 'mexican': 'mexico',
  'brazilian': 'brazil', 'turkish': 'turkey', 'greek': 'greece',
};
const NUMBER_WORDS = {
  'zero': '0', 'one': '1', 'two': '2', 'three': '3', 'four': '4', 'five': '5',
  'six': '6', 'seven': '7', 'eight': '8', 'nine': '9', 'ten': '10',
  'eleven': '11', 'twelve': '12', 'thirteen': '13', 'fourteen': '14', 'fifteen': '15',
  'sixteen': '16', 'seventeen': '17', 'eighteen': '18', 'nineteen': '19', 'twenty': '20',
  'thirty': '30', 'forty': '40', 'fifty': '50', 'sixty': '60', 'seventy': '70',
  'eighty': '80', 'ninety': '90', 'hundred': '100', 'thousand': '1000',
};

function normalizeAnswer(s) {
  return s.toLowerCase().replace(/\b(a|an|the)\b/g, ' ').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}
function simpleStem(word) {
  return word.replace(/ies$/, 'y').replace(/ves$/, 'f').replace(/(s|ed|ing|ly)$/, '').replace(/ied$/, 'y');
}
function normalizeWithNumbers(s) {
  let norm = normalizeAnswer(s);
  for (const [word, digit] of Object.entries(NUMBER_WORDS)) {
    norm = norm.replace(new RegExp('\\b' + word + '\\b', 'g'), digit);
  }
  norm = norm.replace(/(\d+)\s+(\d+)/g, (_, tens, ones) => String(Number(tens) + Number(ones)));
  return norm;
}
function normalizedContains(response, goldAnswer) {
  if (!response || !goldAnswer) return false;
  const cleanResp = response.replace(/\*\*/g, '');
  const normResp = normalizeAnswer(cleanResp);
  const normGold = normalizeAnswer(goldAnswer);
  if (normResp.includes(normGold)) return true;
  if (normGold.includes(normResp) && normResp.length >= 3) return true;
  const goldTokens = normGold.split(' ').filter(t => t.length > 1);
  const respTokens = new Set(normResp.split(' '));
  if (goldTokens.length >= 2) {
    const matched = goldTokens.filter(t => respTokens.has(t)).length;
    if (matched >= goldTokens.length * 0.8) return true;
  }
  const numResp = normalizeWithNumbers(cleanResp);
  const numGold = normalizeWithNumbers(goldAnswer);
  if (numResp.includes(numGold) || numGold.includes(numResp) && numResp.length >= 3) return true;
  const stemGold = normGold.split(' ').map(simpleStem).join(' ');
  const stemResp = normResp.split(' ').map(simpleStem).join(' ');
  if (stemResp.includes(stemGold) || stemGold.includes(stemResp) && stemResp.length >= 3) return true;
  const respWords = normResp.split(' ');
  const goldWords = normGold.split(' ');
  const expandedResp = respWords.map(w => NICKNAME_MAP[w] || w).join(' ');
  const expandedGold = goldWords.map(w => NICKNAME_MAP[w] || w).join(' ');
  if (expandedResp.includes(expandedGold) || expandedGold.includes(expandedResp) && expandedResp.length >= 3) return true;
  if (goldTokens.length >= 3) {
    const stemGoldTokens = goldTokens.map(simpleStem);
    const stemRespTokens = new Set(normResp.split(' ').map(simpleStem));
    const stemMatched = stemGoldTokens.filter(t => stemRespTokens.has(t)).length;
    if (stemMatched >= stemGoldTokens.length * 0.6) return true;
  }
  for (const aliases of COUNTRY_ALIASES) {
    const respInGroup = aliases.some(a => new RegExp(`\\b${a}\\b`).test(normResp));
    const goldInGroup = aliases.some(a => new RegExp(`\\b${a}\\b`).test(normGold));
    if (respInGroup && goldInGroup) return true;
  }
  for (const [demonym, country] of Object.entries(DEMONYM_MAP)) {
    if ((normResp.includes(demonym) && normGold.includes(country)) ||
        (normResp.includes(country) && normGold.includes(demonym))) return true;
  }
  if (goldTokens.length >= 2 && goldTokens.length <= 4) {
    const lastName = goldTokens[goldTokens.length - 1];
    const firstName = goldTokens[0];
    if (lastName.length >= 4 && normResp.split(' ').includes(lastName)) {
      const respWordList = normResp.split(' ');
      const firstPrefix = firstName.substring(0, 3);
      const nicknameExpanded = NICKNAME_MAP[firstName];
      const nicknamePrefix = nicknameExpanded ? nicknameExpanded.substring(0, 3) : null;
      if (respWordList.some(w => w.startsWith(firstPrefix) || (nicknamePrefix && w.startsWith(nicknamePrefix)))) return true;
    }
  }
  const respTokensList = normResp.split(' ').filter(t => t.length > 1);
  if (respTokensList.length >= 2 && respTokensList.length <= 4) {
    const respLastName = respTokensList[respTokensList.length - 1];
    if (respLastName.length >= 4 && normGold.split(' ').includes(respLastName)) {
      const respFirst = respTokensList[0];
      const goldWords2 = normGold.split(' ');
      const respFirstPrefix = respFirst.substring(0, 3);
      const nicknameExpanded = NICKNAME_MAP[respFirst];
      const nicknamePrefix = nicknameExpanded ? nicknameExpanded.substring(0, 3) : null;
      if (goldWords2.some(w => w.startsWith(respFirstPrefix) || (nicknamePrefix && w.startsWith(nicknamePrefix)))) return true;
    }
  }
  return false;
}

// ─── Migration ───

async function migrateToLadybug() {
  console.log('=== Migration: SQLite Graph → LadybugDB ===');
  console.log(`Corpus: ${CORPUS_ID}`);
  console.log(`SQLite: ${SQLITE_PATH}`);
  console.log(`LadybugDB: ${LADYBUG_DB_PATH}`);
  console.log('NOTE: Only graph (nodes+edges) migrated. MemoryStore stays in SQLite.');

  const startMs = Date.now();

  // Source: SQLite
  const db = openDatabase(SQLITE_PATH);
  const sqliteGraphStore = new SQLiteGraphStore(db);

  // Target: LadybugDB
  const pool = new LadybugConnectionPool(LADYBUG_DB_PATH);
  await pool.init();
  const lbGraphStore = new LadybugGraphStore(pool);

  // 1. Migrate GraphStore nodes
  console.log('\n[1/2] Migrating graph nodes...');
  const nodes = await sqliteGraphStore.getNodes(CORPUS_ID);
  console.log(`  Nodes: ${nodes.length}`);
  const NODE_BATCH = 200;
  for (let i = 0; i < nodes.length; i += NODE_BATCH) {
    const batch = nodes.slice(i, i + NODE_BATCH);
    await lbGraphStore.upsertNodes(batch);
    if ((i + NODE_BATCH) % 2000 === 0 || i + NODE_BATCH >= nodes.length) {
      console.log(`  ... ${Math.min(i + NODE_BATCH, nodes.length)}/${nodes.length}`);
    }
  }
  console.log('  ✓ Nodes migrated');

  // 2. Migrate GraphStore edges
  console.log('\n[2/2] Migrating graph edges...');
  const edges = await sqliteGraphStore.getEdges(CORPUS_ID);
  console.log(`  Edges: ${edges.length}`);
  const EDGE_BATCH = 200;
  for (let i = 0; i < edges.length; i += EDGE_BATCH) {
    const batch = edges.slice(i, i + EDGE_BATCH);
    await lbGraphStore.upsertEdges(batch);
    if ((i + EDGE_BATCH) % 2000 === 0 || i + EDGE_BATCH >= edges.length) {
      console.log(`  ... ${Math.min(i + EDGE_BATCH, edges.length)}/${edges.length}`);
    }
  }
  console.log('  ✓ Edges migrated');

  // Verify
  console.log('\n=== Verification ===');
  const tgtNodes = await lbGraphStore.getNodes(CORPUS_ID);
  const tgtEdges = await lbGraphStore.getEdges(CORPUS_ID);
  console.log(`  Nodes: ${nodes.length} → ${tgtNodes.length} ${nodes.length === tgtNodes.length ? '✅' : '❌'}`);
  console.log(`  Edges: ${edges.length} → ${tgtEdges.length} ${edges.length === tgtEdges.length ? '✅' : '❌'}`);
  console.log(`  Duration: ${((Date.now() - startMs) / 1000).toFixed(0)}s`);

  await pool.close();
  db.close();
}

// ─── Query ───

async function evaluateQueries() {
  console.log('=== HotpotQA Benchmark — LadybugDB Graph Backend (Hybrid) ===');
  console.log(`Corpus: ${CORPUS_ID}`);
  console.log(`Questions: ${QUESTIONS_FILE}`);
  console.log('Backend: LadybugDB (graph/PPR) + FileVectorIndex + SQLite (memory/lexicon)');

  const configPath = resolve(REPO_ROOT, 'packages/memgraphrag/config/default.memgraphrag.yml');
  const baseConfig = loadMemGraphRagConfig(configPath);
  const config = resolveConfigFromEnv(baseConfig);
  const apiKey = resolveApiKey(config.providers.apiKeyFile);

  // LadybugDB for graph operations (PPR path)
  const pool = new LadybugConnectionPool(LADYBUG_DB_PATH);
  await pool.init();
  const lbGraphStore = new LadybugGraphStore(pool);
  const graphProjection = new CachedGraphProjection(new LadybugGraphProjection(lbGraphStore));

  // SQLite for memory and lexicon (cached for performance)
  const db = openDatabase(SQLITE_PATH);
  const memoryStore = new CachedMemoryStore(new SQLiteMemoryStore(db));
  const dictionary = new SQLiteLexiconStore(db, CORPUS_ID);
  const thesaurus = new SQLiteLexiconStore(db, CORPUS_ID);

  // FileVectorIndex for vector search (cached in memory)
  const vectorIndex = new CachedFileVectorIndex(VECTORS_DIR);

  // OpenAI providers
  const llm = new OpenAILLMProvider({
    apiKey,
    model: config.providers.llm.model,
  });
  const embedding = new OpenAIEmbeddingProvider({
    apiKey,
    model: config.providers.embedding.model,
  });

  // Hyperparameters
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

  // Build QueryService with LadybugDB graph + hybrid adapters
  const queryService = new DefaultQueryService({
    dictionary,
    expansionPolicy: new ThesaurusExpansionPolicy(thesaurus),
    memoryFilter: new VectorMemoryFilter(embedding, vectorIndex, memoryStore, null),
    nodeInitializer: new SimpleNodeInitializer(memoryStore),
    ppr: new SimplePPR(HP_HUB),
    projection: graphProjection,
    contextBuilder: new SimpleContextBuilder(memoryStore),
    llm,
    hyperParams,
  });

  const questions = JSON.parse(readFileSync(QUESTIONS_FILE, 'utf-8'));
  const results = new Array(questions.length);
  let correct = 0;
  let total = 0;
  const startTime = Date.now();
  const CONCURRENCY = parseInt(process.env.CONCURRENCY || '5');

  console.log(`\n=== Evaluating ${questions.length} queries ===`);
  console.log(`  HyperParams: tp=${HP_TP} hub=${HP_HUB} K=${HP_TOPK} M=${HP_TOPM} ctx=${HP_CTX} effort=${HP_EFFORT} verbosity=${HP_VERBOSITY}`);
  console.log(`  Backend: LadybugDB (${LADYBUG_DB_PATH})`);
  console.log(`  Concurrency: ${CONCURRENCY}`);

  for (let batchStart = 0; batchStart < questions.length; batchStart += CONCURRENCY) {
    const batchEnd = Math.min(batchStart + CONCURRENCY, questions.length);
    const batch = questions.slice(batchStart, batchEnd);

    const batchResults = await Promise.all(batch.map(async (q) => {
      try {
        const result = await queryService.query({
          corpusId: CORPUS_ID,
          text: q.question,
          topK: HP_TOPK,
          topM: HP_TOPM,
          threshold: 0.2,
          contextTokenLimit: HP_CTX,
        });

        const isCorrect = normalizedContains(result.response, q.answer);
        return {
          id: q.id,
          question: q.question,
          goldAnswer: q.answer,
          type: q.type,
          response: result.response,
          correct: isCorrect,
          metrics: result.metrics,
          citationCount: result.citations.length,
        };
      } catch (error) {
        return {
          id: q.id,
          question: q.question,
          goldAnswer: q.answer,
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
  console.log(`BENCHMARK RESULTS: HotpotQA ${BENCH_SIZE} — LadybugDB`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Overall Accuracy (Str-Acc): ${accuracy}% (${correct}/${total})`);
  console.log(`Time: ${totalTime}s (${(totalTime / total).toFixed(1)}s/query)`);
  for (const [type, stats] of Object.entries(byType)) {
    console.log(`  ${type}: ${((stats.correct / stats.total) * 100).toFixed(1)}% (${stats.correct}/${stats.total})`);
  }

  const summary = {
    benchmark: 'HotpotQA',
    backend: 'ladybug',
    sampleSize: total,
    accuracy: parseFloat(accuracy),
    correct,
    total,
    timeSeconds: parseInt(totalTime),
    byType,
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
  if (PHASE === 'migrate' || PHASE === 'all') {
    await migrateToLadybug();
  }
  if (PHASE === 'query' || PHASE === 'all') {
    await evaluateQueries();
  }
}

main().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
