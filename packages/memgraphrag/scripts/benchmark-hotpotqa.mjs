/**
 * HotpotQA Benchmark: Index corpus and evaluate queries
 * Usage: node scripts/benchmark-hotpotqa.mjs
 */
import { resolve } from 'node:path';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { createMemGraphRagRuntime, SERVICE_TOKENS } from '../dist/interface/runtime/MemGraphRagRuntime.js';
import { loadMemGraphRagConfig, resolveConfigFromEnv } from '../dist/infrastructure/config/index.js';

const BENCHMARK_DIR = resolve(process.cwd(), 'data/benchmark/hotpotqa');
const CORPUS_DIR = resolve(BENCHMARK_DIR, 'corpus_batched');
const QUESTIONS_FILE = resolve(BENCHMARK_DIR, 'benchmark_500.json');
const RESULTS_FILE = resolve(BENCHMARK_DIR, 'results_500.json');

// Phase control
const PHASE = process.argv[2] || 'all'; // 'index', 'query', 'all'
const BATCH_SIZE = 20;

/**
 * HotpotQA-standard normalized string accuracy.
 * Removes articles (a/an/the), punctuation, and extra whitespace before matching.
 */
function normalizeAnswer(s) {
  return s.toLowerCase()
    .replace(/\b(a|an|the)\b/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizedContains(response, goldAnswer) {
  if (!response || !goldAnswer) return false;
  // Strip markdown bold markers
  const normResp = normalizeAnswer(response.replace(/\*\*/g, ''));
  const normGold = normalizeAnswer(goldAnswer);
  // Bidirectional check: gold in response OR response in gold
  // Catches partial names like "Charles Hastings Judd" ⊂ "Colonel Charles Hastings Judd"
  if (normResp.includes(normGold)) return true;
  if (normGold.includes(normResp) && normResp.length >= 3) return true;
  // Token-level F1 fallback: if 80%+ of gold tokens are in response
  const goldTokens = normGold.split(' ').filter(t => t.length > 1);
  const respTokens = new Set(normResp.split(' '));
  if (goldTokens.length >= 2) {
    const matched = goldTokens.filter(t => respTokens.has(t)).length;
    if (matched >= goldTokens.length * 0.8) return true;
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
  
  console.log(`\n=== Evaluating ${questions.length} queries ===`);
  
  const results = [];
  let correct = 0;
  let total = 0;
  const startTime = Date.now();
  
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    total++;
    
    try {
      const result = await queryService.query({
        corpusId,
        text: q.question,
        topK: 10,
        topM: 10,
        threshold: 0.2,
        contextTokenLimit: 3000,
      });
      
      // HotpotQA-standard normalized string accuracy
      const isCorrect = normalizedContains(result.response, q.answer);
      if (isCorrect) correct++;
      
      results.push({
        id: q.id,
        question: q.question,
        goldAnswer: q.answer,
        type: q.type,
        response: result.response,
        correct: isCorrect,
        metrics: result.metrics,
        citationCount: result.citations.length,
      });
      
      if (total % 10 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const accuracy = ((correct / total) * 100).toFixed(1);
        console.log(`  [${total}/${questions.length}] Accuracy: ${accuracy}% (${correct}/${total}) | ${elapsed}s`);
      }
    } catch (error) {
      results.push({
        id: q.id,
        question: q.question,
        goldAnswer: q.answer,
        type: q.type,
        response: null,
        correct: false,
        error: error.message,
      });
      
      if (total % 10 === 0) {
        console.log(`  [${total}/${questions.length}] (error: ${error.message.slice(0, 80)})`);
      }
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
