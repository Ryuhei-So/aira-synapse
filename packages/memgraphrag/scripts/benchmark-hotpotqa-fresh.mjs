#!/usr/bin/env node
/**
 * benchmark-hotpotqa-fresh.mjs — EN benchmark using fresh aira-graphdb ingest
 *
 * Usage:
 *   node scripts/benchmark-hotpotqa-fresh.mjs
 *
 * Environment:
 *   OPENAI_API_KEY, AIRA_GRAPHDB_NATIVE_CMD
 *   BENCH_SIZE (default: 500), CONCURRENCY (default: 5)
 *   AGDB_PATH (default: /tmp/hotpotqa-fresh.agdb)
 */
import { resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { loadMemGraphRagConfig, resolveConfigFromEnv, resolveApiKey } from '../dist/infrastructure/config/index.js';
import {
  AiraGraphDbNativeClient, AiraGraphDbGraphStore, AiraGraphDbGraphProjection,
  AiraGraphDbVectorIndex, AiraGraphDbMemoryStore,
  OpenAILLMProvider, OpenAIEmbeddingProvider,
  CachedGraphProjection, CachedMemoryStore,
} from '../dist/infrastructure/index.js';
import { DefaultQueryService } from '../dist/application/query/QueryService.js';
import { VectorMemoryFilter } from '../dist/application/query/VectorMemoryFilter.js';
import { SimpleNodeInitializer } from '../dist/application/query/SimpleNodeInitializer.js';
import { SimplePPR } from '../dist/application/query/SimplePPR.js';
import { SimpleContextBuilder } from '../dist/application/query/SimpleContextBuilder.js';

// ─── Scoring ─────────────────────────────────────────────────────────────────

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
  'french': 'france', 'german': 'germany', 'italian': 'italy', 'spanish': 'spain',
  'dutch': 'netherlands', 'russian': 'russia', 'chinese': 'china', 'japanese': 'japan',
  'korean': 'korea', 'indian': 'india', 'australian': 'australia', 'canadian': 'canada',
};

const NUMBER_WORDS = {
  'zero': '0', 'one': '1', 'two': '2', 'three': '3', 'four': '4', 'five': '5',
  'six': '6', 'seven': '7', 'eight': '8', 'nine': '9', 'ten': '10',
  'eleven': '11', 'twelve': '12', 'thirteen': '13', 'fourteen': '14', 'fifteen': '15',
  'twenty': '20', 'thirty': '30', 'forty': '40', 'fifty': '50',
};

function normalizeAnswer(s) {
  return s.toLowerCase().replace(/\b(a|an|the)\b/g, ' ').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

function simpleStem(word) {
  return word.replace(/ies$/, 'y').replace(/ves$/, 'f').replace(/(s|ed|ing|ly)$/, '').replace(/ied$/, 'y');
}

function normalizeWithNumbers(s) {
  let norm = normalizeAnswer(s);
  for (const [word, digit] of Object.entries(NUMBER_WORDS)) norm = norm.replace(new RegExp('\\b' + word + '\\b', 'g'), digit);
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
  if (numResp.includes(numGold) || (numGold.includes(numResp) && numResp.length >= 3)) return true;

  const stemGold = normGold.split(' ').map(simpleStem).join(' ');
  const stemResp = normResp.split(' ').map(simpleStem).join(' ');
  if (stemResp.includes(stemGold) || (stemGold.includes(stemResp) && stemResp.length >= 3)) return true;

  const respWords = normResp.split(' ');
  const goldWords = normGold.split(' ');
  const expandedResp = respWords.map(w => NICKNAME_MAP[w] || w).join(' ');
  const expandedGold = goldWords.map(w => NICKNAME_MAP[w] || w).join(' ');
  if (expandedResp.includes(expandedGold) || (expandedGold.includes(expandedResp) && expandedResp.length >= 3)) return true;

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
      const firstPrefix = firstName.substring(0, 3);
      const nicknameExpanded = NICKNAME_MAP[firstName];
      const nicknamePrefix = nicknameExpanded ? nicknameExpanded.substring(0, 3) : null;
      if (normResp.split(' ').some(w => w.startsWith(firstPrefix) || (nicknamePrefix && w.startsWith(nicknamePrefix)))) return true;
    }
  }

  return false;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const configPath = resolve(process.cwd(), 'config/default.memgraphrag.yml');
  const baseConfig = loadMemGraphRagConfig(configPath);
  const config = resolveConfigFromEnv(baseConfig);
  const apiKey = resolveApiKey(config.providers.apiKeyFile);

  const corpusId = 'hotpotqa-bench';
  const agdbPath = process.env.AGDB_PATH || '/tmp/hotpotqa-fresh.agdb';
  const BENCH_SIZE = process.env.BENCH_SIZE || '500';
  const CONCURRENCY = parseInt(process.env.CONCURRENCY || '5');
  const QUESTIONS_FILE = resolve(process.cwd(), `data/benchmark/hotpotqa/benchmark_${BENCH_SIZE}.json`);
  const RESULTS_FILE = resolve(process.cwd(), `data/benchmark/hotpotqa/results_fresh_${BENCH_SIZE}.json`);

  const agdbClient = new AiraGraphDbNativeClient(agdbPath);
  await agdbClient.request('ping');
  console.log(`[benchmark] Connected to ${agdbPath}`);

  const graphStore = new AiraGraphDbGraphStore(agdbClient);
  const graphProjection = new CachedGraphProjection(new AiraGraphDbGraphProjection(agdbClient));
  const memoryStore = new CachedMemoryStore(new AiraGraphDbMemoryStore(agdbClient));
  const vectorIndex = new AiraGraphDbVectorIndex(agdbClient);

  const llm = new OpenAILLMProvider({ apiKey, model: config.providers.llm.model });
  const embedding = new OpenAIEmbeddingProvider({ apiKey, model: config.providers.embedding.model, dimensions: config.providers.embedding.dimensions });

  const noopDict = { match: () => [] };
  const noopExpansion = { expand: (terms) => terms };

  const HP_HUB = parseInt(process.env.HP_HUB || '50');
  const HP_TOPK = parseInt(process.env.HP_TOPK || '10');
  const HP_TOPM = parseInt(process.env.HP_TOPM || '10');
  const HP_CTX = parseInt(process.env.HP_CTX || '3000');

  const queryService = new DefaultQueryService({
    dictionary: noopDict,
    expansionPolicy: noopExpansion,
    memoryFilter: new VectorMemoryFilter(embedding, vectorIndex, memoryStore, graphStore),
    nodeInitializer: new SimpleNodeInitializer(memoryStore),
    ppr: new SimplePPR(),
    projection: graphProjection,
    contextBuilder: new SimpleContextBuilder(memoryStore),
    llm,
    hyperParams: { teleportProbability: 0.5, scTemperature: 0, scSamples: 1, hubDegreeThreshold: HP_HUB, reasoningEffort: 'high', verbosity: 'low' },
  });

  const questions = JSON.parse(readFileSync(QUESTIONS_FILE, 'utf-8'));
  console.log(`[benchmark] ${questions.length} questions, concurrency=${CONCURRENCY}`);
  console.log(`[benchmark] Backend: aira-graphdb (fresh ingest)`);

  const results = new Array(questions.length);
  let correct = 0, total = 0;
  const startTime = Date.now();

  for (let batchStart = 0; batchStart < questions.length; batchStart += CONCURRENCY) {
    const batchEnd = Math.min(batchStart + CONCURRENCY, questions.length);
    const batch = questions.slice(batchStart, batchEnd);

    const batchResults = await Promise.all(batch.map(async (q) => {
      try {
        const result = await queryService.query({ corpusId, text: q.question, topK: HP_TOPK, topM: HP_TOPM, threshold: 0.2, contextTokenLimit: HP_CTX });
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
  console.log(`BENCHMARK RESULTS: HotpotQA ${BENCH_SIZE} (Fresh aira-graphdb)`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Overall Accuracy (Str-Acc): ${accuracy}% (${correct}/${total})`);
  console.log(`Time: ${totalTime}s (${(totalTime / total).toFixed(1)}s/query)`);
  for (const [type, stats] of Object.entries(byType)) {
    console.log(`  ${type}: ${((stats.correct / stats.total) * 100).toFixed(1)}% (${stats.correct}/${stats.total})`);
  }

  writeFileSync(RESULTS_FILE, JSON.stringify({ summary: { accuracy: parseFloat(accuracy), correct, total, byType, timeSeconds: parseInt(totalTime), backend: 'aira-graphdb-fresh', timestamp: new Date().toISOString() }, results }, null, 2));
  console.log(`\nResults saved to: ${RESULTS_FILE}`);

  await agdbClient.close();
}

main().catch(err => { console.error(err); process.exit(1); });
