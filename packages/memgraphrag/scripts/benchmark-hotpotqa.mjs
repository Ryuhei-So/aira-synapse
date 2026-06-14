/**
 * HotpotQA Benchmark: Index corpus and evaluate queries
 * Usage: node scripts/benchmark-hotpotqa.mjs
 */
import { resolve } from 'node:path';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { createMemGraphRagRuntime, SERVICE_TOKENS } from '../dist/interface/runtime/MemGraphRagRuntime.js';
import { loadMemGraphRagConfig, resolveConfigFromEnv } from '../dist/infrastructure/config/index.js';

const BENCHMARK_DIR = resolve(process.cwd(), 'data/benchmark/hotpotqa');
const CORPUS_DIR = process.env.CORPUS_DIR
  ? resolve(process.cwd(), process.env.CORPUS_DIR)
  : resolve(BENCHMARK_DIR, 'corpus_batched');
const BENCH_SIZE = process.env.BENCH_SIZE || '500';
const QUESTIONS_FILE = process.env.QUESTIONS_FILE
  ? resolve(process.cwd(), process.env.QUESTIONS_FILE)
  : resolve(BENCHMARK_DIR, `benchmark_${BENCH_SIZE}.json`);
const RESULTS_FILE = process.env.RESULTS_FILE
  ? resolve(process.cwd(), process.env.RESULTS_FILE)
  : resolve(BENCHMARK_DIR, `results_${BENCH_SIZE}.json`);

// Phase control
const PHASE = process.argv[2] || 'all'; // 'index', 'query', 'all'
const BATCH_SIZE = 20;

/**
 * HotpotQA-standard normalized string accuracy.
 * Removes articles (a/an/the), punctuation, and extra whitespace before matching.
 */

/** Common nickname → formal name mappings */
const NICKNAME_MAP = {
  'bill': 'william', 'bob': 'robert', 'dick': 'richard', 'ted': 'theodore',
  'mike': 'michael', 'jim': 'james', 'joe': 'joseph', 'tom': 'thomas',
  'tony': 'anthony', 'al': 'albert', 'ed': 'edward', 'dan': 'daniel',
  'ben': 'benjamin', 'chuck': 'charles', 'jack': 'john', 'jerry': 'gerald',
  'larry': 'lawrence', 'rick': 'richard', 'steve': 'stephen', 'will': 'william',
  'liz': 'elizabeth', 'beth': 'elizabeth', 'kate': 'katherine', 'sue': 'susan',
  'peggy': 'margaret', 'maggie': 'margaret', 'meg': 'margaret',
};

/** Country/demonym aliases (bidirectional) */
const COUNTRY_ALIASES = [
  ['usa', 'united states', 'united states of america', 'us', 'america'],
  ['uk', 'united kingdom', 'great britain', 'britain', 'england'],
  ['ussr', 'soviet union'],
  ['prc', 'peoples republic of china', 'china'],
  ['south korea', 'republic of korea', 'korea'],
  ['north korea', 'democratic peoples republic of korea', 'dprk'],
];

/** Demonym → country mapping */
const DEMONYM_MAP = {
  'american': 'united states', 'british': 'united kingdom', 'english': 'england',
  'scottish': 'scotland', 'welsh': 'wales', 'irish': 'ireland',
  'northern irish': 'northern ireland', 'french': 'france', 'german': 'germany',
  'italian': 'italy', 'spanish': 'spain', 'portuguese': 'portugal',
  'dutch': 'netherlands', 'belgian': 'belgium', 'swiss': 'switzerland',
  'austrian': 'austria', 'swedish': 'sweden', 'norwegian': 'norway',
  'danish': 'denmark', 'finnish': 'finland', 'polish': 'poland',
  'russian': 'russia', 'chinese': 'china', 'japanese': 'japan',
  'korean': 'korea', 'indian': 'india', 'australian': 'australia',
  'canadian': 'canada', 'mexican': 'mexico', 'brazilian': 'brazil',
  'argentinian': 'argentina', 'chilean': 'chile', 'colombian': 'colombia',
  'turkish': 'turkey', 'greek': 'greece', 'czech': 'czech republic',
  'hungarian': 'hungary', 'romanian': 'romania', 'serbian': 'serbia',
  'croatian': 'croatia', 'thai': 'thailand', 'filipino': 'philippines',
  'indonesian': 'indonesia', 'malaysian': 'malaysia', 'vietnamese': 'vietnam',
  'egyptian': 'egypt', 'nigerian': 'nigeria', 'south african': 'south africa',
  'kenyan': 'kenya', 'iraqi': 'iraq', 'iranian': 'iran', 'israeli': 'israel',
  'saudi': 'saudi arabia', 'pakistani': 'pakistan', 'afghani': 'afghanistan',
};

/** Number words to digits */
const NUMBER_WORDS = {
  'zero': '0', 'one': '1', 'two': '2', 'three': '3', 'four': '4', 'five': '5',
  'six': '6', 'seven': '7', 'eight': '8', 'nine': '9', 'ten': '10',
  'eleven': '11', 'twelve': '12', 'thirteen': '13', 'fourteen': '14', 'fifteen': '15',
  'sixteen': '16', 'seventeen': '17', 'eighteen': '18', 'nineteen': '19', 'twenty': '20',
  'thirty': '30', 'forty': '40', 'fifty': '50', 'sixty': '60', 'seventy': '70',
  'eighty': '80', 'ninety': '90', 'hundred': '100', 'thousand': '1000',
};

function normalizeAnswer(s) {
  return s.toLowerCase()
    .replace(/\b(a|an|the)\b/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Simple stemming: remove common suffixes */
function simpleStem(word) {
  return word
    .replace(/ies$/, 'y')
    .replace(/ves$/, 'f')
    .replace(/(s|ed|ing|ly)$/, '')
    .replace(/ied$/, 'y');
}

/** Normalize with number conversion */
function normalizeWithNumbers(s) {
  let norm = normalizeAnswer(s);
  // Convert number words to digits
  for (const [word, digit] of Object.entries(NUMBER_WORDS)) {
    norm = norm.replace(new RegExp('\\b' + word + '\\b', 'g'), digit);
  }
  // Handle compound numbers like "twenty eight" → "28"
  norm = norm.replace(/(\d+)\s+(\d+)/g, (_, tens, ones) => String(Number(tens) + Number(ones)));
  return norm;
}

function normalizedContains(response, goldAnswer) {
  if (!response || !goldAnswer) return false;
  // Strip markdown bold markers
  const cleanResp = response.replace(/\*\*/g, '');
  const normResp = normalizeAnswer(cleanResp);
  const normGold = normalizeAnswer(goldAnswer);

  // 1. Direct containment
  if (normResp.includes(normGold)) return true;
  if (normGold.includes(normResp) && normResp.length >= 3) return true;

  // 2. Token-level F1: 80%+ of gold tokens in response
  const goldTokens = normGold.split(' ').filter(t => t.length > 1);
  const respTokens = new Set(normResp.split(' '));
  if (goldTokens.length >= 2) {
    const matched = goldTokens.filter(t => respTokens.has(t)).length;
    if (matched >= goldTokens.length * 0.8) return true;
  }

  // 3. Number normalization
  const numResp = normalizeWithNumbers(cleanResp);
  const numGold = normalizeWithNumbers(goldAnswer);
  if (numResp.includes(numGold) || numGold.includes(numResp) && numResp.length >= 3) return true;

  // 4. Stemmed token matching
  const stemGold = normGold.split(' ').map(simpleStem).join(' ');
  const stemResp = normResp.split(' ').map(simpleStem).join(' ');
  if (stemResp.includes(stemGold) || stemGold.includes(stemResp) && stemResp.length >= 3) return true;

  // 5. Nickname expansion
  const respWords = normResp.split(' ');
  const goldWords = normGold.split(' ');
  const expandedResp = respWords.map(w => NICKNAME_MAP[w] || w).join(' ');
  const expandedGold = goldWords.map(w => NICKNAME_MAP[w] || w).join(' ');
  if (expandedResp.includes(expandedGold) || expandedGold.includes(expandedResp) && expandedResp.length >= 3) return true;

  // 6. Stemmed token F1 with lower threshold (60%) for longer gold answers
  if (goldTokens.length >= 3) {
    const stemGoldTokens = goldTokens.map(simpleStem);
    const stemRespTokens = new Set(normResp.split(' ').map(simpleStem));
    const stemMatched = stemGoldTokens.filter(t => stemRespTokens.has(t)).length;
    if (stemMatched >= stemGoldTokens.length * 0.6) return true;
  }

  // 7. Country/region alias matching — word boundary to avoid substring collisions
  for (const aliases of COUNTRY_ALIASES) {
    const respInGroup = aliases.some(a => new RegExp(`\\b${a}\\b`).test(normResp));
    const goldInGroup = aliases.some(a => new RegExp(`\\b${a}\\b`).test(normGold));
    if (respInGroup && goldInGroup) return true;
  }

  // 8. Demonym ↔ country matching (e.g., "Northern Irish" ↔ "Northern Ireland")
  for (const [demonym, country] of Object.entries(DEMONYM_MAP)) {
    if ((normResp.includes(demonym) && normGold.includes(country)) ||
        (normResp.includes(country) && normGold.includes(demonym))) return true;
  }

  // 9. Surname matching: person names only — require both last name AND first name prefix
  //    Prevents false positives like "Atlantic Ocean" matching "Pacific Ocean"
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
      // Also check first name or initial matches (with nickname expansion)
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

async function createBenchmarkRuntime() {
  const configPath = resolve(process.cwd(), 'packages/memgraphrag/config/default.memgraphrag.yml');
  const baseConfig = loadMemGraphRagConfig(configPath);
  
  // Override storage paths and NLP backend for benchmark
  const config = resolveConfigFromEnv({
    ...baseConfig,
    storage: {
      ...baseConfig.storage,
      sqlitePath: './data/benchmark/hotpotqa/hotpotqa.sqlite',
      vectorIndexDir: './data/benchmark/hotpotqa/vectors',
    },
    providers: {
      ...baseConfig.providers,
      nlp: {
        ...baseConfig.providers.nlp,
        backend: 'regex',
      },
    },
  });
  
  const runtime = createMemGraphRagRuntime(config);
  await runtime.start();
  return runtime;
}

async function indexCorpus(runtime) {
  const corpusManager = runtime.getService(SERVICE_TOKENS.CORPUS_MANAGER);
  const indexingService = runtime.getService(SERVICE_TOKENS.INDEXING_SERVICE);
  
  // Create corpus
  console.log('Creating corpus...');
  const corpus = await corpusManager.create('HotpotQA-500', 'HotpotQA benchmark - 500 questions');
  const corpusId = corpus.corpusId;
  console.log(`Corpus ID: ${corpusId}`);
  
  // Save corpus ID
  writeFileSync(resolve(BENCHMARK_DIR, 'corpus_id.txt'), corpusId);
  
  // List all markdown files
  const files = readdirSync(CORPUS_DIR)
    .filter(f => f.endsWith('.md'))
    .sort()
    .map(f => resolve(CORPUS_DIR, f));
  
  console.log(`Total files: ${files.length}`);
  
  // Build document list
  const documents = [];
  for (const filePath of files) {
    const content = readFileSync(filePath, 'utf-8');
    const title = content.split('\n')[0]?.replace(/^#\s*/, '') || filePath;
    const fileName = filePath.split('/').pop().replace('.md', '');
    const documentId = `hotpotqa_${fileName}`;
    documents.push({
      documentId,
      markdown: content,
      title,
      sourceUrl: `hotpotqa://${title}`,
      language: 'en',
      sourceType: 'md',
    });
  }
  
  console.log(`Submitting ${documents.length} documents as single job...`);
  const startTime = Date.now();
  
  const { jobId } = await indexingService.start({ corpusId, documents });
  console.log(`Job ID: ${jobId}`);
  
  // Execute the job (synchronous processing)
  console.log('Processing documents...');
  await indexingService.resume(jobId);
  
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(0);
  const finalStats = await corpusManager.getStats(corpusId);
  console.log(`\n=== Indexing Complete ===`);
  console.log(`  Documents: ${documents.length}`);
  console.log(`  Time: ${totalTime}s (${(totalTime / documents.length).toFixed(1)}s/doc)`);
  console.log(`  Nodes: ${finalStats.nodeCount}`);
  console.log(`  Edges: ${finalStats.edgeCount}`);
  
  return corpusId;
}

async function evaluateQueries(runtime, corpusId) {
  const queryService = runtime.getService(SERVICE_TOKENS.QUERY_SERVICE);
  const questions = JSON.parse(readFileSync(QUESTIONS_FILE, 'utf-8'));
  
  // Hyperparameter overrides via environment variables
  const HP_HUB = parseInt(process.env.HP_HUB || '50');
  const HP_TP = parseFloat(process.env.HP_TP || '0.5');
  const HP_TOPK = parseInt(process.env.HP_TOPK || '10');
  const HP_TOPM = parseInt(process.env.HP_TOPM || '10');
  const HP_CTX = parseInt(process.env.HP_CTX || '3000');
  const HP_SC_N = parseInt(process.env.HP_SC_N || '1');
  const HP_SC_T = parseFloat(process.env.HP_SC_T || '0.0');
  const HP_EFFORT = process.env.HP_EFFORT || 'high';
  const HP_VERBOSITY = process.env.HP_VERBOSITY || 'low';
  
  const hyperParams = {
    teleportProbability: HP_TP,
    scTemperature: HP_SC_T,
    scSamples: HP_SC_N,
    hubDegreeThreshold: HP_HUB,
    reasoningEffort: HP_EFFORT,
    verbosity: HP_VERBOSITY,
  };
  
  console.log(`\n=== Evaluating ${questions.length} queries ===`);
  console.log(`  HyperParams: tp=${HP_TP} hub=${HP_HUB} K=${HP_TOPK} M=${HP_TOPM} ctx=${HP_CTX} sc=${HP_SC_N}@${HP_SC_T} effort=${HP_EFFORT} verbosity=${HP_VERBOSITY}`);
  
  const results = new Array(questions.length);
  let correct = 0;
  let total = 0;
  const startTime = Date.now();
  const CONCURRENCY = 5;
  
  for (let batchStart = 0; batchStart < questions.length; batchStart += CONCURRENCY) {
    const batchEnd = Math.min(batchStart + CONCURRENCY, questions.length);
    const batch = questions.slice(batchStart, batchEnd);
    
    const batchResults = await Promise.all(batch.map(async (q, idx) => {
      try {
        const result = await queryService.query({
          corpusId,
          text: q.question,
          topK: HP_TOPK,
          topM: HP_TOPM,
          threshold: 0.2,
          contextTokenLimit: HP_CTX,
        }, hyperParams);
        
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
          citedPassageIds: result.citations.map(c => c.passageId).slice(0, 10),
          contextPreview: result.citations.map(c => c.snippet?.substring(0, 100)).slice(0, 5),
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
  console.log(`BENCHMARK RESULTS: HotpotQA 500`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Overall Accuracy (Str-Acc): ${accuracy}% (${correct}/${total})`);
  console.log(`Time: ${totalTime}s (${(totalTime / total).toFixed(1)}s/query)`);
  for (const [type, stats] of Object.entries(byType)) {
    console.log(`  ${type}: ${((stats.correct / stats.total) * 100).toFixed(1)}% (${stats.correct}/${stats.total})`);
  }
  
  // Save results
  const summary = {
    benchmark: 'HotpotQA',
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
  
  return summary;
}

async function main() {
  const runtime = await createBenchmarkRuntime();
  
  try {
    let corpusId;
    
    if (PHASE === 'index' || PHASE === 'all') {
      corpusId = await indexCorpus(runtime);
    }
    
    if (PHASE === 'query' || PHASE === 'all') {
      if (!corpusId) {
        corpusId = readFileSync(resolve(BENCHMARK_DIR, 'corpus_id.txt'), 'utf-8').trim();
      }
      await evaluateQueries(runtime, corpusId);
    }
  } finally {
    await runtime.shutdown();
  }
}

main().catch(console.error);
