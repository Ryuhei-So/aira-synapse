/**
 * Retry failed JA questions with gpt-5.5
 * Loads results_ja_agdb.json, re-runs only failed questions with gpt-5.5
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

const ROOT_DATA_DIR = resolve(process.cwd(), '../../data/benchmark/hotpotqa-ja');
const PKG_DATA_DIR = resolve(process.cwd(), 'data/benchmark/hotpotqa-ja');
const QUESTIONS_FILE = resolve(ROOT_DATA_DIR, 'hotpotqa_ja_500.json');
const CORPUS_ID = '4484a03a-210a-4154-ac2f-c98d648f358a';

// --- Model to use for retry ---
const RETRY_MODEL = process.env.RETRY_MODEL || 'gpt-5.5';

// --- Japanese answer normalization (same as baseline) ---
function normalizeJa(s) {
  if (!s) return '';
  return s.toLowerCase().normalize('NFKC')
    .replace(/[\s　]+/g, ' ')
    .replace(/[、。，．・「」『』（）()【】\[\]{}""'']/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .trim();
}

const KATAKANA_VARIANTS = [
  [/ヴァ/g, 'バ'], [/ヴィ/g, 'ビ'], [/ヴェ/g, 'ベ'], [/ヴォ/g, 'ボ'], [/ヴ/g, 'ブ'],
  [/ティ/g, 'チ'], [/ディ/g, 'ジ'], [/デュ/g, 'ジュ'],
  [/ファ/g, 'ハ'], [/フィ/g, 'ヒ'], [/フェ/g, 'ヘ'], [/フォ/g, 'ホ'],
  [/ウィ/g, 'ウイ'], [/ウェ/g, 'ウエ'], [/ウォ/g, 'ウオ'],
  [/ッ/g, ''], [/ー/g, ''],
];

function normalizeKatakana(s) {
  let r = s;
  for (const [pat, rep] of KATAKANA_VARIANTS) r = r.replace(pat, rep);
  return r;
}

function extractLatin(s) {
  return (s.match(/[a-zA-Z0-9\s\-'.]+/g) || []).join(' ').trim().toLowerCase();
}

function normalizedContainsJa(response, answer) {
  if (!response || !answer) return false;
  const normResp = normalizeJa(response);
  const normAns = normalizeJa(answer);
  if (!normAns) return false;
  if (normResp.includes(normAns)) return true;
  if (normalizeKatakana(normResp).includes(normalizeKatakana(normAns))) return true;
  const latinResp = extractLatin(response);
  const latinAns = extractLatin(answer);
  if (latinAns && latinAns.length >= 2 && latinResp.includes(latinAns)) return true;
  if (normAns.length >= 3) {
    const tokens = normAns.split(/\s+/);
    if (tokens.length > 1 && tokens.every(t => t.length >= 2 && normResp.includes(t))) return true;
  }
  return false;
}

let _llmJudgeCount = 0;
async function llmJudge(question, goldJa, goldEn, response, apiKey) {
  if (!apiKey || !response || response.length < 5) return false;
  _llmJudgeCount++;
  try {
    const body = {
      model: 'gpt-5.4-mini',
      messages: [{ role: 'user', content:
        'You are a strict QA evaluator. Is the response semantically equivalent to the gold answer (same entity/fact)? Output ONLY YES or NO.\n\n' +
        'Question: ' + question + '\nGold: ' + goldJa + ' (' + goldEn + ')\nResponse: ' + response + '\nVerdict:' }],
      max_completion_tokens: 5,
    };
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) return false;
    const d = await r.json();
    return d.choices?.[0]?.message?.content?.trim()?.toUpperCase()?.includes('YES') ?? false;
  } catch { return false; }
}

async function main() {
  const configPath = resolve(process.cwd(), 'config/default.memgraphrag.yml');
  const baseConfig = loadMemGraphRagConfig(configPath);
  const config = resolveConfigFromEnv(baseConfig);
  const apiKey = resolveApiKey(config.providers.apiKeyFile);

  // Load baseline results to identify failed questions
  const baselineResults = JSON.parse(readFileSync(resolve(PKG_DATA_DIR, 'results_ja_agdb.json'), 'utf-8'));
  const failedQuestions = baselineResults.filter(r => !r.correct);
  console.log(`\n=== Retry failed questions with ${RETRY_MODEL} ===`);
  console.log(`  Failed in baseline: ${failedQuestions.length}/${baselineResults.length}`);

  // Load original questions to get type info
  const allQuestions = JSON.parse(readFileSync(QUESTIONS_FILE, 'utf-8'));
  const questionMap = new Map(allQuestions.map(q => [q.question_ja, q]));

  // aira-graphdb
  const agdbPath = resolve(PKG_DATA_DIR, 'hotpotqa-ja.agdb');
  const agdbClient = new AiraGraphDbNativeClient(agdbPath);
  await agdbClient.request('ping');
  console.log(`  Connected to ${agdbPath}`);

  const vectorIndex = new AiraGraphDbVectorIndex(agdbClient);
  const memoryStore = new CachedMemoryStore(new AiraGraphDbMemoryStore(agdbClient));
  const graphProjection = new CachedGraphProjection(new AiraGraphDbGraphProjection(agdbClient));

  const sqlitePath = resolve(ROOT_DATA_DIR, 'hotpotqa-ja.sqlite');
  const emptyDict = { match: async () => [], upsertEntries: async () => {}, suggest: async () => [], exportJson: async () => ({}), importJson: async () => {}, getStatistics: async () => ({ totalEntries: 0, totalLanguages: 0, byLanguage: {} }) };
  let dictionary, thesaurus;
  try {
    const db = openDatabase(sqlitePath);
    dictionary = new SQLiteLexiconStore(db, CORPUS_ID);
    thesaurus = new SQLiteLexiconStore(db, CORPUS_ID);
  } catch {
    dictionary = emptyDict;
    thesaurus = emptyDict;
  }

  // Use gpt-5.5 for answer generation
  const llm = new OpenAILLMProvider({ apiKey, model: RETRY_MODEL });
  console.log(`  LLM model: ${RETRY_MODEL}`);

  const embedding = new OpenAIEmbeddingProvider({
    apiKey,
    model: config.providers.embedding.model,
    dimensions: config.providers.embedding.dimensions,
  });

  const HP_HUB = 50, HP_TOPK = 10, HP_TOPM = 10, HP_CTX = 3000;

  const hyperParams = {
    teleportProbability: 0.5,
    scTemperature: 0,
    scSamples: 1,
    hubDegreeThreshold: HP_HUB,
    reasoningEffort: 'high',
    verbosity: 'low',
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
  const { PythonSidecarExtractor } = await import('../dist/infrastructure/nlp/PythonSidecarExtractor.js');
  const graphStore = new AiraGraphDbGraphStore(agdbClient);
  const baseLexicalRetriever = new AiraGraphDbLexicalRetriever(agdbClient);

  let sidecar = null;
  const tokenizedLexicalRetriever = {
    search: async (corpusId, query, topK) => {
      let tokenizedQuery = query;
      try {
        if (!sidecar) { sidecar = new PythonSidecarExtractor(); await sidecar.healthCheck(); }
        const tokens = await sidecar.tokenizeJa(query);
        if (tokens && tokens.length > 0) tokenizedQuery = tokens.join(' ');
      } catch {}
      return baseLexicalRetriever.search(corpusId, tokenizedQuery, topK);
    },
    indexPassages: (c, p) => baseLexicalRetriever.indexPassages(c, p),
    deleteByDocument: (c, d) => baseLexicalRetriever.deleteByDocument(c, d),
    deleteByCorpus: (c) => baseLexicalRetriever.deleteByCorpus(c),
  };

  const memoryFilter = new HybridMemoryFilter(embedding, vectorIndex, memoryStore, tokenizedLexicalRetriever, graphStore);

  const queryService = new DefaultQueryService({
    dictionary,
    expansionPolicy: new ThesaurusExpansionPolicy(thesaurus),
    memoryFilter,
    nodeInitializer: new SimpleNodeInitializer(memoryStore),
    ppr: new SimplePPR(),
    projection: graphProjection,
    contextBuilder: new SimpleContextBuilder(memoryStore),
    llm,
    hyperParams,
    featureFlags,
  });

  async function expandQuery(queryJa) {
    if (!sidecar) return queryJa;
    try {
      const entResult = await sidecar.extractEntitiesJa(queryJa);
      if (entResult.entities && entResult.entities.length > 0) {
        const entityNames = entResult.entities.filter(e => e.text && e.text.length >= 2).map(e => e.text);
        if (entityNames.length > 0) return queryJa + ' ' + entityNames.join(' ');
      }
    } catch {}
    return queryJa;
  }

  const CONCURRENCY = parseInt(process.env.CONCURRENCY || '3');
  let correct = 0, total = 0;
  const startTime = Date.now();
  const results = [];
  let bridgeCorrect = 0, bridgeTotal = 0, compCorrect = 0, compTotal = 0;

  for (let batchStart = 0; batchStart < failedQuestions.length; batchStart += CONCURRENCY) {
    const batch = failedQuestions.slice(batchStart, batchStart + CONCURRENCY);

    const batchResults = await Promise.all(batch.map(async (q) => {
      try {
        const expandedQuery = await expandQuery(q.question_ja);
        const result = await queryService.query({
          corpusId: CORPUS_ID,
          text: expandedQuery,
          topK: HP_TOPK,
          topM: HP_TOPM,
          threshold: 0.2,
          contextTokenLimit: HP_CTX,
        });
        const isCorrectJa = normalizedContainsJa(result.response, q.answer_ja);
        const isCorrectEn = normalizedContainsJa(result.response, q.answer_en);
        let isCorrect = isCorrectJa || isCorrectEn;
        let matchMethod = isCorrectJa ? 'ja_match' : isCorrectEn ? 'en_match' : 'none';

        if (!isCorrect && result.response && result.response.length >= 2) {
          const judged = await llmJudge(q.question_ja, q.answer_ja, q.answer_en, result.response, apiKey);
          if (judged) { isCorrect = true; matchMethod = 'llm_judge'; }
        }

        const orig = questionMap.get(q.question_ja);
        return {
          question_ja: q.question_ja, answer_ja: q.answer_ja,
          question_en: q.question_en, answer_en: q.answer_en,
          response: result.response, correct: isCorrect,
          matchedJa: isCorrectJa, matchedEn: isCorrectEn, matchMethod,
          type: orig?.type || q.type,
          baseline_response: q.response,
        };
      } catch (err) {
        return {
          question_ja: q.question_ja, answer_ja: q.answer_ja,
          question_en: q.question_en, answer_en: q.answer_en,
          response: `ERROR: ${err.message}`, correct: false,
          matchedJa: false, matchedEn: false, type: q.type,
          baseline_response: q.response,
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
    process.stdout.write(`\r  [${total}/${failedQuestions.length}] recovered ${correct} (${acc}%) (${elapsed}s) B:${bridgeTotal ? ((bridgeCorrect / bridgeTotal) * 100).toFixed(0) : '?'}% C:${compTotal ? ((compCorrect / compTotal) * 100).toFixed(0) : '?'}%   `);
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(0);
  const recoveryRate = ((correct / total) * 100).toFixed(1);
  const llmJudged = results.filter(r => r.matchMethod === 'llm_judge').length;

  // Calculate combined score
  const baselineCorrect = baselineResults.filter(r => r.correct).length;
  const combinedCorrect = baselineCorrect + correct;
  const combinedTotal = baselineResults.length;
  const combinedAcc = ((combinedCorrect / combinedTotal) * 100).toFixed(1);

  console.log(`\n\n=== Retry Results (${RETRY_MODEL}) ===`);
  console.log(`  Recovered: ${correct}/${total} (${recoveryRate}%)`);
  console.log(`  Bridge recovered: ${bridgeCorrect}/${bridgeTotal}`);
  console.log(`  Comparison recovered: ${compCorrect}/${compTotal}`);
  console.log(`  LLM Judge recovered: ${llmJudged}`);
  console.log(`  Time: ${totalTime}s (${(totalTime / total).toFixed(1)}s/q)`);
  console.log(`\n=== Combined Score (baseline + retry) ===`);
  console.log(`  Baseline: ${baselineCorrect}/${combinedTotal} (${((baselineCorrect/combinedTotal)*100).toFixed(1)}%)`);
  console.log(`  + ${RETRY_MODEL} retry: ${correct} recovered`);
  console.log(`  Combined: ${combinedCorrect}/${combinedTotal} (${combinedAcc}%)`);

  writeFileSync(resolve(PKG_DATA_DIR, `results_ja_retry_${RETRY_MODEL.replace(/\./g, '')}.json`), JSON.stringify(results, null, 2));
  console.log(`  Results saved to: results_ja_retry_${RETRY_MODEL.replace(/\./g, '')}.json`);

  await agdbClient.close();
  if (sidecar) try { await sidecar.shutdown(); } catch {}
}

main().catch(err => { console.error(err); process.exit(1); });
