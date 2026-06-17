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
import { DictionaryAwareNodeInitializer } from '../dist/application/query/DictionaryAwareNodeInitializer.js';
import { SimplePPR } from '../dist/application/query/SimplePPR.js';
import { SimpleContextBuilder } from '../dist/application/query/SimpleContextBuilder.js';
import { AliasAwareContextBuilder } from '../dist/application/query/AliasAwareContextBuilder.js';
import { SubQueryDecomposer } from '../dist/application/query/SubQueryDecomposer.js';
import { ComparisonVerifier } from '../dist/application/query/ComparisonVerifier.js';
import { ThesaurusExpansionPolicy } from '../dist/application/index.js';
import { DEFAULT_QUERY_FLAGS, V15_BASELINE_QUERY_FLAGS } from '../dist/domain/config/featureFlags.js';

// ─── Paths ───
// Benchmark data lives at repo root, not package root
const REPO_ROOT = resolve(process.cwd(), '../..');
const BENCHMARK_DIR = resolve(REPO_ROOT, 'data/benchmark/hotpotqa');
const LADYBUG_DB_PATH = process.env.LADYBUG_DB_PATH
  ? resolve(process.cwd(), process.env.LADYBUG_DB_PATH)
  : resolve(BENCHMARK_DIR, 'hotpotqa.lbug');
const SQLITE_PATH = process.env.SQLITE_PATH
  ? resolve(process.cwd(), process.env.SQLITE_PATH)
  : resolve(BENCHMARK_DIR, 'hotpotqa.sqlite');
const VECTORS_DIR = resolve(BENCHMARK_DIR, 'vectors');
const BENCH_SIZE = process.env.BENCH_SIZE || '500';
const QUESTIONS_FILE = process.env.QUESTIONS_FILE
  ? resolve(process.cwd(), process.env.QUESTIONS_FILE)
  : resolve(BENCHMARK_DIR, `benchmark_${BENCH_SIZE}.json`);
const RESULTS_FILE = process.env.RESULTS_FILE
  ? resolve(process.cwd(), process.env.RESULTS_FILE)
  : resolve(BENCHMARK_DIR, `results_ladybug_${BENCH_SIZE}.json`);
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
  return word
    .replace(/ies$/, 'y')
    .replace(/ves$/, 'f')
    .replace(/(ance|ence|ment|tion|sion)s?$/, '')
    .replace(/(er|or|ist|ism)s?$/, '')
    .replace(/(s|ed|ing|ly)$/, '')
    .replace(/ied$/, 'y');
}
function normalizeWithNumbers(s) {
  let norm = normalizeAnswer(s);
  // Handle compound forms first: "twenty-eight" / "twenty eight"
  const compoundRe = /\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\s*(one|two|three|four|five|six|seven|eight|nine)\b/g;
  norm = norm.replace(compoundRe, (_, tens, ones) => {
    const TENS = {'twenty':'20','thirty':'30','forty':'40','fifty':'50','sixty':'60','seventy':'70','eighty':'80','ninety':'90'};
    const ONES = {'one':'1','two':'2','three':'3','four':'4','five':'5','six':'6','seven':'7','eight':'8','nine':'9'};
    return String(Number(TENS[tens]) + Number(ONES[ones]));
  });
  // Then replace remaining single number words
  for (const [word, digit] of Object.entries(NUMBER_WORDS)) {
    norm = norm.replace(new RegExp('\\b' + word + '\\b', 'g'), digit);
  }
  return norm;
}

/** Check if initials match full name: "j. cole" vs "jermaine lamarr cole" */
function initialsMatch(shorter, longer) {
  const shortTokens = shorter.replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(t => t.length > 0);
  const longTokens = longer.replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(t => t.length > 0);
  if (shortTokens.length < 2 || longTokens.length < 2) return false;
  // Last token must match
  const shortLast = shortTokens[shortTokens.length - 1];
  const longLast = longTokens[longTokens.length - 1];
  if (shortLast !== longLast) return false;
  // Check initials for preceding tokens
  const shortPrefixes = shortTokens.slice(0, -1);
  const longPrefixes = longTokens.slice(0, -1);
  if (shortPrefixes.length > longPrefixes.length) return false;
  for (let i = 0; i < shortPrefixes.length; i++) {
    const sp = shortPrefixes[i];
    // sp could be an initial (1 char) or abbreviation
    if (sp.length <= 2) {
      if (!longPrefixes[i]?.startsWith(sp[0])) return false;
    } else {
      if (longPrefixes[i] !== sp && !longPrefixes[i]?.startsWith(sp)) return false;
    }
  }
  return true;
}

/** Check abbreviation: "hc" vs "hockey club" */
function abbreviationMatch(shorter, longer) {
  const shortNorm = shorter.replace(/[^a-z0-9 ]/g, '').trim();
  const longNorm = longer.replace(/[^a-z0-9 ]/g, '').trim();
  const longTokens = longNorm.split(/\s+/);
  // Check if shorter is an acronym of longer
  const acronym = longTokens.map(t => t[0]).join('');
  if (shortNorm.replace(/\s+/g, '') === acronym) return true;
  // Check if one side has an acronym prefix: "hc davos" vs "hockey club davos"
  const shortTokens = shortNorm.split(/\s+/);
  if (shortTokens.length >= 2 && longTokens.length >= shortTokens.length) {
    const suffix = shortTokens.slice(-1)[0];
    const longSuffix = longTokens.slice(-1)[0];
    if (suffix === longSuffix) {
      const prefix = shortTokens.slice(0, -1).join('');
      const longPrefixAcronym = longTokens.slice(0, -1).map(t => t[0]).join('');
      if (prefix === longPrefixAcronym) return true;
    }
  }
  return false;
}

/** Pure numeric comparison after stripping units */
function numericMatch(resp, gold) {
  const respNum = resp.replace(/[^0-9]/g, '');
  const goldNum = gold.replace(/[^0-9]/g, '');
  if (respNum && goldNum && respNum === goldNum && respNum.length >= 1) return true;
  return false;
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
  // Initials matching: "j. cole" vs "jermaine lamarr cole", "a.p. møller" vs "arnold peter møller"
  if (initialsMatch(normResp, normGold) || initialsMatch(normGold, normResp)) return true;
  // Abbreviation matching: "hc davos" vs "hockey club davos"
  if (abbreviationMatch(normResp, normGold) || abbreviationMatch(normGold, normResp)) return true;
  // Pure numeric match after stripping units: "twenty-eight seasons" vs "28"
  if (numericMatch(numResp, numGold)) return true;
  // Stemmed token overlap for short gold answers (1-2 words)
  if (goldTokens.length >= 1 && goldTokens.length <= 2) {
    const stemGoldShort = goldTokens.map(simpleStem);
    const stemRespSet = new Set(normResp.split(' ').map(simpleStem));
    const stemMatch = stemGoldShort.filter(t => stemRespSet.has(t)).length;
    if (stemMatch === goldTokens.length) return true;
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

  // Feature flags (env-based override, defaults to all-on)
  const V15_MODE = process.env.V15_BASELINE === 'true';
  const V03_MODE = process.env.V03_ALL_ON === 'true';
  const featureFlags = V15_MODE ? V15_BASELINE_QUERY_FLAGS
    : V03_MODE ? {
      enableDictionaryInjection: process.env.FLAG_DICT_INJECT !== 'false',
      enableThesaurusExpansion: process.env.FLAG_THESAURUS !== 'false',
      enableHypernymExpansion: process.env.FLAG_HYPERNYM === 'true',
      enableAliasHints: process.env.FLAG_ALIAS !== 'false',
      enableSubQueryDecomposition: process.env.FLAG_SUBQUERY !== 'false',
      enableComparisonVerification: process.env.FLAG_COMPARISON !== 'false',
    }
    : {
      // Default: use DEFAULT_QUERY_FLAGS with optional env overrides
      enableDictionaryInjection: process.env.FLAG_DICT_INJECT === 'true',
      enableThesaurusExpansion: process.env.FLAG_THESAURUS === 'true',
      enableHypernymExpansion: process.env.FLAG_HYPERNYM === 'true',
      enableAliasHints: process.env.FLAG_ALIAS === 'true',
      enableSubQueryDecomposition: process.env.FLAG_SUBQUERY === 'true',
      enableComparisonVerification: process.env.FLAG_COMPARISON === 'true',
    };

  // Build components based on flags
  // Note: Dictionary injection is now context-based (inside QueryService), not teleport-vector-based
  const baseInitializer = new SimpleNodeInitializer(memoryStore);
  const nodeInitializer = baseInitializer;

  const baseContextBuilder = new SimpleContextBuilder(memoryStore);
  const contextBuilder = featureFlags.enableAliasHints
    ? new AliasAwareContextBuilder(baseContextBuilder, dictionary, thesaurus)
    : baseContextBuilder;

  const expansionPolicy = new ThesaurusExpansionPolicy(
    thesaurus,
    { synonymLimit: 3, hypernymLimit: featureFlags.enableHypernymExpansion ? 2 : 0 },
    featureFlags.enableThesaurusExpansion ? dictionary : undefined,
  );

  const ppr = new SimplePPR(HP_HUB);

  const subQueryDecomposer = featureFlags.enableSubQueryDecomposition
    ? new SubQueryDecomposer(llm, baseInitializer, ppr, graphProjection)
    : undefined;

  const comparisonVerifier = featureFlags.enableComparisonVerification
    ? new ComparisonVerifier(llm)
    : undefined;

  // Build QueryService with LadybugDB graph + hybrid adapters
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
    subQueryDecomposer,
    comparisonVerifier,
  });

  const allQuestions = JSON.parse(readFileSync(QUESTIONS_FILE, 'utf-8'));
  const NUM_Q = parseInt(process.env.NUM_QUESTIONS || '0');
  const questions = NUM_Q > 0 ? allQuestions.slice(0, NUM_Q) : allQuestions;
  const results = new Array(questions.length);
  let correct = 0;
  let total = 0;
  const startTime = Date.now();
  const CONCURRENCY = parseInt(process.env.CONCURRENCY || '5');

  console.log(`\n=== Evaluating ${questions.length} queries ===`);
  console.log(`  HyperParams: tp=${HP_TP} hub=${HP_HUB} K=${HP_TOPK} M=${HP_TOPM} ctx=${HP_CTX} effort=${HP_EFFORT} verbosity=${HP_VERBOSITY}`);
  console.log(`  Flags: ${V15_MODE ? 'V15_BASELINE (all off)' : V03_MODE ? 'V03_ALL_ON' : 'DEFAULT (all off)'} ${JSON.stringify(featureFlags)}`);
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
    featureFlags,
    v15Baseline: V15_MODE,
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
