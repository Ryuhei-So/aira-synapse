/**
 * HotpotQA Japanese Benchmark: Pure aira-graphdb backend
 * Tests: AiraGraphDbVectorIndex + AiraGraphDbMemoryStore + AiraGraphDbGraphProjection
 * Questions/Answers in Japanese (question_ja / answer_ja fields)
 *
 * Usage: node scripts/benchmark-hotpotqa-ja-agdb.mjs [--hybrid]
 */
import { resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { loadMemGraphRagConfig, resolveConfigFromEnv, resolveApiKey } from '../dist/infrastructure/config/index.js';
import {
  SQLiteLexiconStore, OpenAILLMProvider, OpenAIEmbeddingProvider,
  CachedMemoryStore, CachedGraphProjection,
  AiraGraphDbNativeClient, AiraGraphDbGraphProjection,
  AiraGraphDbVectorIndex, AiraGraphDbMemoryStore,
  openDatabase,
} from '../dist/infrastructure/index.js';
import { DefaultQueryService } from '../dist/application/query/QueryService.js';
import { VectorMemoryFilter } from '../dist/application/query/VectorMemoryFilter.js';
import { HybridMemoryFilter } from '../dist/application/query/HybridMemoryFilter.js';
import { SimpleNodeInitializer } from '../dist/application/query/SimpleNodeInitializer.js';
import { SimplePPR } from '../dist/application/query/SimplePPR.js';
import { SimpleContextBuilder } from '../dist/application/query/SimpleContextBuilder.js';
import { ThesaurusExpansionPolicy } from '../dist/application/index.js';

// --- JA benchmark paths ---
const ROOT_DATA_DIR = resolve(process.cwd(), '../../data/benchmark/hotpotqa-ja');
const PKG_DATA_DIR = resolve(process.cwd(), 'data/benchmark/hotpotqa-ja');
const QUESTIONS_FILE = resolve(ROOT_DATA_DIR, 'hotpotqa_ja_500.json');
const CORPUS_ID = '4484a03a-210a-4154-ac2f-c98d648f358a';

// --- Japanese answer normalization ---
function normalizeJa(s) {
  if (!s) return '';
  return s
    .toLowerCase()
    .normalize('NFKC')                        // 全角→半角統一
    .replace(/[\s　]+/g, ' ')                  // 全角スペース統一
    .replace(/[、。，．・「」『』（）()【】\[\]{}""'']/g, '')  // 日本語句読点・括弧除去
    .replace(/[^\p{L}\p{N}\s]/gu, '')          // 記号除去 (Unicode letter/number 以外)
    .trim();
}

// Kanji number map
const KANJI_NUM = {
  '零': '0', '一': '1', '二': '2', '三': '3', '四': '4',
  '五': '5', '六': '6', '七': '7', '八': '8', '九': '9',
  '十': '10', '百': '100', '千': '1000', '万': '10000',
};

function kanjiToArabic(s) {
  // Simple single-kanji substitution (複雑な組み合わせは別途)
  let r = s;
  for (const [k, v] of Object.entries(KANJI_NUM)) {
    r = r.replace(new RegExp(k, 'g'), v);
  }
  return r;
}

function normalizedContainsJa(response, answer) {
  if (!response || !answer) return false;

  const cleanResp = response.replace(/\*\*/g, '');
  const normResp = normalizeJa(cleanResp);
  const normGold = normalizeJa(answer);

  // 1. Direct containment
  if (normResp.includes(normGold)) return true;
  if (normGold.includes(normResp) && normResp.length >= 2) return true;

  // 2. Token overlap (space-split for JA — works for mixed content)
  const goldChars = [...normGold.replace(/\s/g, '')];
  const respStr = normResp.replace(/\s/g, '');
  if (goldChars.length >= 2) {
    // Character-level containment (JA doesn't tokenize by space well)
    const matched = goldChars.filter(c => respStr.includes(c)).length;
    if (matched >= goldChars.length * 0.85) return true;
  }

  // 3. Kanji number normalization
  const kanjiResp = kanjiToArabic(normResp);
  const kanjiGold = kanjiToArabic(normGold);
  if (kanjiResp.includes(kanjiGold) || kanjiGold.includes(kanjiResp)) return true;

  // 4. Year/number extraction: both contain the same significant number
  const numsResp = normResp.match(/\d{3,}/g) || [];
  const numsGold = normGold.match(/\d{3,}/g) || [];
  if (numsGold.length > 0 && numsGold.every(n => numsResp.includes(n))) return true;

  // 5. English answer fallback (some gold answers are in English even for JA questions)
  const normRespEn = normResp.replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  const normGoldEn = normGold.replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  if (normGoldEn.length >= 3 && normRespEn.includes(normGoldEn)) return true;
  if (normRespEn.length >= 3 && normGoldEn.includes(normRespEn)) return true;

  // 6. Edit distance ≤ 1 for short answers
  if (normGold.length >= 3 && normGold.length <= 10) {
    let diffs = 0;
    const a = normGold.replace(/\s/g, '');
    const b = normResp.replace(/\s/g, '');
    if (Math.abs(a.length - b.length) <= 1) {
      let ai = 0, bi = 0;
      while (ai < a.length && bi < b.length) {
        if (a[ai] !== b[bi]) {
          diffs++;
          if (diffs > 1) break;
          if (a.length > b.length) ai++;
          else if (b.length > a.length) bi++;
          else { ai++; bi++; }
        } else { ai++; bi++; }
      }
      if (diffs + (a.length - ai) + (b.length - bi) <= 1) return true;
    }
  }

  return false;
}

async function main() {
  const configPath = resolve(process.cwd(), 'config/default.memgraphrag.yml');
  const baseConfig = loadMemGraphRagConfig(configPath);
  const config = resolveConfigFromEnv(baseConfig);
  const apiKey = resolveApiKey(config.providers.apiKeyFile);

  // aira-graphdb
  const agdbPath = resolve(PKG_DATA_DIR, 'hotpotqa-ja.agdb');
  const agdbClient = new AiraGraphDbNativeClient(agdbPath);
  await agdbClient.request('ping');
  console.log(`[ja-agdb] Connected to ${agdbPath}`);

  const vectorIndex = new AiraGraphDbVectorIndex(agdbClient);
  const memoryStore = new CachedMemoryStore(new AiraGraphDbMemoryStore(agdbClient));
  const graphProjection = new CachedGraphProjection(new AiraGraphDbGraphProjection(agdbClient));

  // Dictionary/Thesaurus: SQLite (if exists, otherwise skip)
  const sqlitePath = resolve(ROOT_DATA_DIR, 'hotpotqa-ja.sqlite');
  const emptyDict = {
    match: async () => [],
    upsertEntries: async () => {},
    suggest: async () => [],
    exportJson: async () => ({}),
    importJson: async () => {},
    getStatistics: async () => ({ totalEntries: 0, totalLanguages: 0, byLanguage: {} }),
  };
  let dictionary, thesaurus;
  try {
    const db = openDatabase(sqlitePath);
    dictionary = new SQLiteLexiconStore(db, CORPUS_ID);
    thesaurus = new SQLiteLexiconStore(db, CORPUS_ID);
  } catch {
    console.log('[ja-agdb] No SQLite lexicon found, using empty stores');
    dictionary = emptyDict;
    thesaurus = emptyDict;
  }

  const llm = new OpenAILLMProvider({ apiKey, model: config.providers.llm.model });
  const embedding = new OpenAIEmbeddingProvider({
    apiKey,
    model: config.providers.embedding.model,
    dimensions: config.providers.embedding.dimensions,
  });

  const HP_HUB = parseInt(process.env.HP_HUB || '50');
  const HP_TOPK = parseInt(process.env.HP_TOPK || '10');
  const HP_TOPM = parseInt(process.env.HP_TOPM || '10');
  const HP_CTX = parseInt(process.env.HP_CTX || '3000');
  const HP_EFFORT = process.env.HP_EFFORT || 'high';
  const HP_VERBOSITY = process.env.HP_VERBOSITY || 'low';
  const ENABLE_HYBRID = process.argv.includes('--hybrid') || process.env.HYBRID === '1';

  const hyperParams = {
    teleportProbability: 0.5,
    scTemperature: 0,
    scSamples: 1,
    hubDegreeThreshold: HP_HUB,
    reasoningEffort: HP_EFFORT,
    verbosity: HP_VERBOSITY,
  };

  const featureFlags = {
    enableDictionaryInjection: false,
    enableThesaurusExpansion: false,
    enableHypernymExpansion: false,
    enableAliasHints: false,
    enableSubQueryDecomposition: false,
    enableComparisonVerification: false,
    enableMultiHopReasoning: false,
  };

  const { AiraGraphDbGraphStore, AiraGraphDbLexicalRetriever } = await import('../dist/infrastructure/index.js');
  const graphStore = new AiraGraphDbGraphStore(agdbClient);
  const lexicalRetriever = new AiraGraphDbLexicalRetriever(agdbClient);

  const memoryFilter = ENABLE_HYBRID
    ? new HybridMemoryFilter(embedding, vectorIndex, memoryStore, lexicalRetriever, graphStore)
    : new VectorMemoryFilter(embedding, vectorIndex, memoryStore, graphStore);

  const queryService = new DefaultQueryService({
    dictionary,
    expansionPolicy: new ThesaurusExpansionPolicy(thesaurus),
    memoryFilter,
    nodeInitializer: new SimpleNodeInitializer(memoryStore),
    ppr: new SimplePPR(HP_HUB),
    projection: graphProjection,
    contextBuilder: new SimpleContextBuilder(memoryStore),
    llm,
    hyperParams,
    featureFlags,
  });

  // Load questions — only those with ja_coverage
  const allQuestions = JSON.parse(readFileSync(QUESTIONS_FILE, 'utf-8'));
  const questions = allQuestions.filter(q => q.ja_coverage !== false && q.ja_coverage !== 0 && q.question_ja && q.answer_ja);
  console.log(`\n=== Japanese aira-graphdb Benchmark: ${questions.length}/${allQuestions.length} questions (${allQuestions.length - questions.length} skipped, no JA coverage) ===`);
  console.log(`  Vector: AiraGraphDbVectorIndex`);
  console.log(`  Memory: AiraGraphDbMemoryStore`);
  console.log(`  Graph: AiraGraphDbGraphProjection`);
  console.log(`  Hybrid (Vector+BM25): ${ENABLE_HYBRID ? 'ENABLED' : 'disabled'}`);
  console.log(`  HyperParams: hub=${HP_HUB} K=${HP_TOPK} M=${HP_TOPM} ctx=${HP_CTX} effort=${HP_EFFORT}`);
  console.log(`  Chunking: GINZA sentence-based`);

  const CONCURRENCY = parseInt(process.env.CONCURRENCY || '5');
  let correct = 0, total = 0;
  const startTime = Date.now();
  const results = [];
  let bridgeCorrect = 0, bridgeTotal = 0, compCorrect = 0, compTotal = 0;

  for (let batchStart = 0; batchStart < questions.length; batchStart += CONCURRENCY) {
    const batch = questions.slice(batchStart, batchStart + CONCURRENCY);

    const batchResults = await Promise.all(batch.map(async (q) => {
      try {
        const result = await queryService.query({
          corpusId: CORPUS_ID,
          text: q.question_ja,
          topK: HP_TOPK,
          topM: HP_TOPM,
          threshold: 0.2,
          contextTokenLimit: HP_CTX,
        });
        // Check both JA and EN answers
        const isCorrectJa = normalizedContainsJa(result.response, q.answer_ja);
        const isCorrectEn = normalizedContainsJa(result.response, q.answer);
        const isCorrect = isCorrectJa || isCorrectEn;
        return {
          question_ja: q.question_ja, answer_ja: q.answer_ja,
          question_en: q.question, answer_en: q.answer,
          response: result.response, correct: isCorrect,
          matchedJa: isCorrectJa, matchedEn: isCorrectEn,
          type: q.type,
        };
      } catch (err) {
        return {
          question_ja: q.question_ja, answer_ja: q.answer_ja,
          question_en: q.question, answer_en: q.answer,
          response: `ERROR: ${err.message}`, correct: false,
          matchedJa: false, matchedEn: false, type: q.type,
        };
      }
    }));

    for (const r of batchResults) {
      results.push(r);
      total++;
      if (r.correct) correct++;
      if (r.type === 'bridge') { bridgeTotal++; if (r.correct) bridgeCorrect++; }
      if (r.type === 'comparison') { compTotal++; if (r.correct) compCorrect++; }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const acc = ((correct / total) * 100).toFixed(1);
    process.stdout.write(`\r  [${total}/${questions.length}] ${acc}% (${elapsed}s) B:${bridgeTotal ? ((bridgeCorrect / bridgeTotal) * 100).toFixed(0) : '?'}% C:${compTotal ? ((compCorrect / compTotal) * 100).toFixed(0) : '?'}%   `);
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(0);
  const accuracy = ((correct / total) * 100).toFixed(1);
  console.log(`\n\n=== Results (Japanese) ===`);
  console.log(`  Overall: ${accuracy}% (${correct}/${total})`);
  console.log(`  Bridge: ${bridgeTotal ? ((bridgeCorrect / bridgeTotal) * 100).toFixed(1) : 'N/A'}% (${bridgeCorrect}/${bridgeTotal})`);
  console.log(`  Comparison: ${compTotal ? ((compCorrect / compTotal) * 100).toFixed(1) : 'N/A'}% (${compCorrect}/${compTotal})`);
  console.log(`  Time: ${totalTime}s (${(totalTime / total).toFixed(1)}s/q)`);
  console.log(`  Backend: PURE aira-graphdb (JA, GINZA chunked) + SQLite dict`);
  console.log(`  Previous baseline: 58.5% (234/400) on LadybugDB+Neo4j`);

  writeFileSync(resolve(PKG_DATA_DIR, 'results_ja_agdb.json'), JSON.stringify(results, null, 2));
  console.log(`  Results saved to: ${resolve(PKG_DATA_DIR, 'results_ja_agdb.json')}`);

  await agdbClient.close();
}

main().catch(err => { console.error(err); process.exit(1); });
