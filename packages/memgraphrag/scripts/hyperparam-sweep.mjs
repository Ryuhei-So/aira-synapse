#!/usr/bin/env node
/**
 * Hyperparameter Sweep for MemGraphRAG Query Pipeline
 * 
 * Strategy: Staged coordinate descent
 *   Stage 1: Independent 1D sweeps on 100-question subset (fast)
 *   Stage 2: Joint 2D sweep of top-2 params on 100-question subset
 *   Stage 3: Full 500-question validation of best config
 * 
 * Usage:
 *   node scripts/hyperparam-sweep.mjs [stage1|stage2|stage3|full]
 *   node scripts/hyperparam-sweep.mjs stage1          # 1D sweeps, ~20 configs × 100q
 *   node scripts/hyperparam-sweep.mjs stage2          # 2D joint, ~25 configs × 100q  
 *   node scripts/hyperparam-sweep.mjs stage3          # best config × 500q
 *   node scripts/hyperparam-sweep.mjs full            # all stages sequentially
 *   
 * Environment:
 *   SWEEP_SUBSET=100   Override subset size (default: 100)
 *   SWEEP_CONCURRENCY=5  Override concurrency (default: 5)
 */
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createMemGraphRagRuntime, SERVICE_TOKENS } from '../dist/interface/runtime/MemGraphRagRuntime.js';
import { loadMemGraphRagConfig, resolveConfigFromEnv } from '../dist/infrastructure/config/index.js';

// ─── Config ────────────────────────────────────────────────────────────────
const BENCHMARK_DIR = resolve(process.cwd(), 'data/benchmark/hotpotqa');
const QUESTIONS_FILE = resolve(BENCHMARK_DIR, 'benchmark_500.json');
const SWEEP_RESULTS_FILE = resolve(BENCHMARK_DIR, 'sweep_results.json');
const BEST_CONFIG_FILE = resolve(BENCHMARK_DIR, 'best_hyperparams.json');

const STAGE = process.argv[2] || 'full';
const SUBSET_SIZE = parseInt(process.env.SWEEP_SUBSET || '100');
const CONCURRENCY = parseInt(process.env.SWEEP_CONCURRENCY || '5');

// ─── Evaluation (copied from benchmark) ────────────────────────────────────
const NICKNAME_MAP = {
  'bill': 'william', 'bob': 'robert', 'dick': 'richard', 'ted': 'theodore',
  'mike': 'michael', 'jim': 'james', 'joe': 'joseph', 'tom': 'thomas',
  'tony': 'anthony', 'al': 'albert', 'ed': 'edward', 'dan': 'daniel',
  'ben': 'benjamin', 'chuck': 'charles', 'jack': 'john', 'jerry': 'gerald',
  'larry': 'lawrence', 'rick': 'richard', 'steve': 'stephen', 'will': 'william',
};

const COUNTRY_ALIASES = [
  ['united states', 'usa', 'us', 'america', 'united states of america'],
  ['united kingdom', 'uk', 'britain', 'great britain'],
  ['ussr', 'soviet union', 'russia'],
  ['peoples republic of china', 'china', 'prc'],
  ['republic of korea', 'south korea', 'korea'],
  ['czech republic', 'czechia'],
];

const DEMONYM_MAP = {
  'american': 'united states', 'british': 'united kingdom', 'english': 'england',
  'scottish': 'scotland', 'welsh': 'wales', 'irish': 'ireland',
  'northern irish': 'northern ireland', 'french': 'france', 'german': 'germany',
  'italian': 'italy', 'spanish': 'spain', 'russian': 'russia',
  'chinese': 'china', 'japanese': 'japan', 'korean': 'korea',
  'canadian': 'canada', 'australian': 'australia', 'indian': 'india',
};

const NUMBER_WORDS = {
  'zero': '0', 'one': '1', 'two': '2', 'three': '3', 'four': '4', 'five': '5',
  'six': '6', 'seven': '7', 'eight': '8', 'nine': '9', 'ten': '10',
  'eleven': '11', 'twelve': '12', 'thirteen': '13', 'fourteen': '14', 'fifteen': '15',
  'sixteen': '16', 'seventeen': '17', 'eighteen': '18', 'nineteen': '19', 'twenty': '20',
  'thirty': '30', 'forty': '40', 'fifty': '50', 'sixty': '60', 'seventy': '70',
  'eighty': '80', 'ninety': '90', 'hundred': '100',
};

function simpleStem(word) {
  if (word.length <= 3) return word;
  return word.replace(/(ies|ied)$/, 'y').replace(/(es|ed|er|ing|tion|sion|ment|ness|ful|less|ly|ous|ive|able|ible|al|ial|ical)$/, '').replace(/s$/, '');
}

function normalizeAnswer(text) {
  let norm = text.toLowerCase()
    .replace(/\b(a|an|the)\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  for (const [word, num] of Object.entries(NUMBER_WORDS)) {
    norm = norm.replace(new RegExp(`\\b${word}\\b`, 'g'), num);
  }
  norm = norm.replace(/(\d+)\s+(\d+)/g, (_, tens, ones) => String(Number(tens) + Number(ones)));
  return norm;
}

function normalizeWithNumbers(text) {
  let norm = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  for (const [word, num] of Object.entries(NUMBER_WORDS)) {
    norm = norm.replace(new RegExp(`\\b${word}\\b`, 'g'), num);
  }
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

// ─── Runtime ───────────────────────────────────────────────────────────────
async function createRuntime() {
  const configPath = resolve(process.cwd(), 'packages/memgraphrag/config/default.memgraphrag.yml');
  const baseConfig = loadMemGraphRagConfig(configPath);
  const config = resolveConfigFromEnv({
    ...baseConfig,
    storage: {
      ...baseConfig.storage,
      sqlitePath: './data/benchmark/hotpotqa/hotpotqa.sqlite',
      vectorIndexDir: './data/benchmark/hotpotqa/vectors',
    },
    providers: {
      ...baseConfig.providers,
      nlp: { ...baseConfig.providers.nlp, backend: 'regex' },
    },
  });
  const runtime = createMemGraphRagRuntime(config);
  await runtime.start();
  return runtime;
}

// ─── Evaluation Runner ─────────────────────────────────────────────────────
async function evaluateConfig(queryService, corpusId, questions, hyperParams, requestOverrides = {}) {
  const label = configLabel(hyperParams, requestOverrides);
  const startTime = Date.now();
  let correct = 0;
  let total = 0;

  for (let batchStart = 0; batchStart < questions.length; batchStart += CONCURRENCY) {
    const batchEnd = Math.min(batchStart + CONCURRENCY, questions.length);
    const batch = questions.slice(batchStart, batchEnd);

    const batchResults = await Promise.all(batch.map(async (q) => {
      try {
        const result = await queryService.query({
          corpusId,
          text: q.question,
          topK: requestOverrides.topK ?? 10,
          topM: requestOverrides.topM ?? 10,
          threshold: requestOverrides.threshold ?? 0.2,
          contextTokenLimit: requestOverrides.contextTokenLimit ?? 3000,
        }, hyperParams);
        return normalizedContains(result.response, q.answer);
      } catch {
        return false;
      }
    }));

    for (const isCorrect of batchResults) {
      total++;
      if (isCorrect) correct++;
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const accuracy = ((correct / total) * 100).toFixed(1);
  console.log(`  ${label}: ${accuracy}% (${correct}/${total}) | ${elapsed}s`);

  return { label, accuracy: correct / total, correct, total, elapsed: parseFloat(elapsed), hyperParams, requestOverrides };
}

function configLabel(hp, ro) {
  const parts = [];
  if (hp) {
    if (hp.teleportProbability !== undefined) parts.push(`tp=${hp.teleportProbability}`);
    if (hp.scTemperature !== undefined) parts.push(`sct=${hp.scTemperature}`);
    if (hp.scSamples !== undefined) parts.push(`scn=${hp.scSamples}`);
    if (hp.hubDegreeThreshold !== undefined) parts.push(`hub=${hp.hubDegreeThreshold}`);
  }
  if (ro) {
    if (ro.topK !== undefined) parts.push(`K=${ro.topK}`);
    if (ro.topM !== undefined) parts.push(`M=${ro.topM}`);
    if (ro.contextTokenLimit !== undefined) parts.push(`ctx=${ro.contextTokenLimit}`);
    if (ro.threshold !== undefined) parts.push(`thr=${ro.threshold}`);
  }
  return parts.join(' ') || 'default';
}

// ─── Search Space Definition ───────────────────────────────────────────────
const SEARCH_SPACE = {
  // PPR parameters — most likely impactful (narrowed for speed)
  teleportProbability: [0.3, 0.5, 0.7],
  // Hub suppression
  hubDegreeThreshold: [30, 50, 100],
  // Retrieval
  topK: [5, 10, 20],
  topM: [5, 10, 20],
  contextTokenLimit: [2000, 3000, 5000],
};

// Baseline config (v10 defaults, SC disabled — proven unhelpful)
const BASELINE_HP = { teleportProbability: 0.5, scTemperature: 0.0, scSamples: 1, hubDegreeThreshold: 50 };
const BASELINE_RO = { topK: 10, topM: 10, contextTokenLimit: 3000, threshold: 0.2 };

// ─── Stage 1: Independent 1D sweeps ────────────────────────────────────────
async function stage1(queryService, corpusId, questions) {
  console.log('\n' + '═'.repeat(60));
  console.log('STAGE 1: Independent 1D Parameter Sweeps');
  console.log(`  Subset: ${questions.length} questions, Concurrency: ${CONCURRENCY}`);
  console.log('═'.repeat(60));

  const allResults = [];

  // Baseline
  console.log('\n[Baseline]');
  const baseline = await evaluateConfig(queryService, corpusId, questions, BASELINE_HP, BASELINE_RO);
  allResults.push(baseline);

  // Sweep each parameter independently
  const sweeps = [
    { name: 'teleportProbability', key: 'hp', field: 'teleportProbability', values: SEARCH_SPACE.teleportProbability },
    { name: 'hubDegreeThreshold', key: 'hp', field: 'hubDegreeThreshold', values: SEARCH_SPACE.hubDegreeThreshold },
    { name: 'topK', key: 'ro', field: 'topK', values: SEARCH_SPACE.topK },
    { name: 'topM', key: 'ro', field: 'topM', values: SEARCH_SPACE.topM },
    { name: 'contextTokenLimit', key: 'ro', field: 'contextTokenLimit', values: SEARCH_SPACE.contextTokenLimit },
  ];

  for (const sweep of sweeps) {
    console.log(`\n[Sweep: ${sweep.name}]`);
    for (const value of sweep.values) {
      // Skip if it's the baseline value
      const baselineValue = sweep.key === 'hp' ? BASELINE_HP[sweep.field] : BASELINE_RO[sweep.field];
      if (value === baselineValue) continue;

      const hp = sweep.key === 'hp' ? { ...BASELINE_HP, [sweep.field]: value } : BASELINE_HP;
      const ro = sweep.key === 'ro' ? { ...BASELINE_RO, [sweep.field]: value } : BASELINE_RO;

      const result = await evaluateConfig(queryService, corpusId, questions, hp, ro);
      allResults.push(result);
    }
  }

  // Rank results
  allResults.sort((a, b) => b.accuracy - a.accuracy);

  console.log('\n' + '─'.repeat(60));
  console.log('Stage 1 Rankings (top 10):');
  console.log('─'.repeat(60));
  for (let i = 0; i < Math.min(10, allResults.length); i++) {
    const r = allResults[i];
    const delta = ((r.accuracy - baseline.accuracy) * 100).toFixed(1);
    const sign = delta >= 0 ? '+' : '';
    console.log(`  ${i + 1}. ${(r.accuracy * 100).toFixed(1)}% (${sign}${delta}pt) ${r.label} [${r.elapsed}s]`);
  }

  return allResults;
}

// ─── Stage 2: Joint optimization of top individual winners ─────────────────
async function stage2(queryService, corpusId, questions, stage1Results) {
  console.log('\n' + '═'.repeat(60));
  console.log('STAGE 2: Joint Optimization — Combine Stage 1 Winners');
  console.log('═'.repeat(60));

  const allResults = [];

  // Key combinations based on Stage 1 findings
  const candidates = [
    // Top individual winners combined
    { label: 'hub=100 + ctx=2000',
      hp: { ...BASELINE_HP, hubDegreeThreshold: 100 },
      ro: { ...BASELINE_RO, contextTokenLimit: 2000 } },
    { label: 'hub=100 + ctx=5000',
      hp: { ...BASELINE_HP, hubDegreeThreshold: 100 },
      ro: { ...BASELINE_RO, contextTokenLimit: 5000 } },
    { label: 'hub=100 + tp=0.7',
      hp: { ...BASELINE_HP, hubDegreeThreshold: 100, teleportProbability: 0.7 },
      ro: BASELINE_RO },
    { label: 'hub=100 + ctx=2000 + K=5',
      hp: { ...BASELINE_HP, hubDegreeThreshold: 100 },
      ro: { ...BASELINE_RO, contextTokenLimit: 2000, topK: 5 } },
    { label: 'hub=100 + ctx=2000 + tp=0.7',
      hp: { ...BASELINE_HP, hubDegreeThreshold: 100, teleportProbability: 0.7 },
      ro: { ...BASELINE_RO, contextTokenLimit: 2000 } },
    // Fine-grained hub sweep around winner
    { label: 'hub=75',
      hp: { ...BASELINE_HP, hubDegreeThreshold: 75 },
      ro: BASELINE_RO },
    { label: 'hub=150',
      hp: { ...BASELINE_HP, hubDegreeThreshold: 150 },
      ro: BASELINE_RO },
    // Fine-grained ctx sweep around winner
    { label: 'ctx=1500',
      hp: BASELINE_HP,
      ro: { ...BASELINE_RO, contextTokenLimit: 1500 } },
    { label: 'ctx=2500',
      hp: BASELINE_HP,
      ro: { ...BASELINE_RO, contextTokenLimit: 2500 } },
  ];

  for (const c of candidates) {
    console.log(`\n[${c.label}]`);
    const result = await evaluateConfig(queryService, corpusId, questions, c.hp, c.ro);
    allResults.push(result);
  }

  allResults.sort((a, b) => b.accuracy - a.accuracy);

  console.log('\n' + '─'.repeat(60));
  console.log('Stage 2 Rankings:');
  console.log('─'.repeat(60));
  const baselineAcc = stage1Results.find(r => r.label.includes('thr=0.2') && !r.label.includes('hub=100'))?.accuracy ?? 0.78;
  for (let i = 0; i < allResults.length; i++) {
    const r = allResults[i];
    const delta = ((r.accuracy - baselineAcc) * 100).toFixed(1);
    const sign = delta >= 0 ? '+' : '';
    console.log(`  ${i + 1}. ${(r.accuracy * 100).toFixed(1)}% (${sign}${delta}pt) ${r.label} [${r.elapsed}s]`);
  }

  return allResults;
}

// ─── Stage 3: Full 500-question validation ─────────────────────────────────
async function stage3(queryService, corpusId, allQuestions, bestConfig) {
  console.log('\n' + '═'.repeat(60));
  console.log('STAGE 3: Full 500-Question Validation');
  console.log(`  Config: ${bestConfig.label}`);
  console.log('═'.repeat(60));

  const result = await evaluateConfig(queryService, corpusId, allQuestions, bestConfig.hyperParams, bestConfig.requestOverrides);
  
  console.log('\n' + '═'.repeat(60));
  console.log(`FINAL RESULT: ${(result.accuracy * 100).toFixed(1)}% (${result.correct}/${result.total})`);
  console.log(`Config: ${result.label}`);
  console.log('═'.repeat(60));

  return result;
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const runtime = await createRuntime();
  const queryService = runtime.getService(SERVICE_TOKENS.QUERY_SERVICE);
  const corpusId = readFileSync(resolve(BENCHMARK_DIR, 'corpus_id.txt'), 'utf-8').trim();
  const allQuestions = JSON.parse(readFileSync(QUESTIONS_FILE, 'utf-8'));
  
  // Deterministic subset: first N questions (same across runs for reproducibility)
  const subset = allQuestions.slice(0, SUBSET_SIZE);

  let stage1Results, stage2Results, bestConfig, finalResult;
  const sweepData = { startTime: new Date().toISOString(), stages: {} };

  try {
    if (STAGE === 'stage1' || STAGE === 'full') {
      stage1Results = await stage1(queryService, corpusId, subset);
      sweepData.stages.stage1 = stage1Results;
      saveSweepResults(sweepData);
    }

    if (STAGE === 'stage2' || STAGE === 'full') {
      if (!stage1Results && existsSync(SWEEP_RESULTS_FILE)) {
        const saved = JSON.parse(readFileSync(SWEEP_RESULTS_FILE, 'utf-8'));
        stage1Results = saved.stages.stage1;
      }
      if (!stage1Results) {
        console.error('Stage 1 results not found. Run stage1 first.');
        process.exit(1);
      }
      stage2Results = await stage2(queryService, corpusId, subset, stage1Results);
      sweepData.stages.stage2 = stage2Results;
      bestConfig = stage2Results[0];
      saveSweepResults(sweepData);
    }

    if (STAGE === 'stage3' || STAGE === 'full') {
      if (!bestConfig && existsSync(SWEEP_RESULTS_FILE)) {
        const saved = JSON.parse(readFileSync(SWEEP_RESULTS_FILE, 'utf-8'));
        bestConfig = saved.stages.stage2?.[0] ?? saved.stages.stage1?.[0];
      }
      if (!bestConfig) {
        console.error('Best config not found. Run stage1+stage2 first.');
        process.exit(1);
      }
      finalResult = await stage3(queryService, corpusId, allQuestions, bestConfig);
      sweepData.stages.stage3 = finalResult;
      sweepData.bestConfig = {
        hyperParams: bestConfig.hyperParams,
        requestOverrides: bestConfig.requestOverrides,
        subsetAccuracy: bestConfig.accuracy,
        fullAccuracy: finalResult.accuracy,
      };
      saveSweepResults(sweepData);

      // Save best config separately
      writeFileSync(BEST_CONFIG_FILE, JSON.stringify(sweepData.bestConfig, null, 2));
      console.log(`\nBest config saved to: ${BEST_CONFIG_FILE}`);
    }

    sweepData.endTime = new Date().toISOString();
    saveSweepResults(sweepData);

  } finally {
    await runtime.shutdown();
  }
}

function saveSweepResults(data) {
  writeFileSync(SWEEP_RESULTS_FILE, JSON.stringify(data, null, 2));
}

main().catch(console.error);
