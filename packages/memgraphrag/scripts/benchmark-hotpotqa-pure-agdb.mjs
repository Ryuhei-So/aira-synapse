/**
 * HotpotQA Benchmark: Pure aira-graphdb backend
 * Tests: AiraGraphDbVectorIndex + AiraGraphDbMemoryStore + AiraGraphDbGraphProjection
 * Dictionary/Thesaurus: SQLite (same as 88.4% baseline)
 *
 * Usage: node scripts/benchmark-hotpotqa-pure-agdb.mjs
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
import { SimpleNodeInitializer } from '../dist/application/query/SimpleNodeInitializer.js';
import { SimplePPR } from '../dist/application/query/SimplePPR.js';
import { SimpleContextBuilder } from '../dist/application/query/SimpleContextBuilder.js';
import { ThesaurusExpansionPolicy } from '../dist/application/index.js';

const BENCHMARK_DIR = resolve(process.cwd(), 'data/benchmark/hotpotqa');
const BENCH_SIZE = process.env.BENCH_SIZE || '500';
const QUESTIONS_FILE = resolve(BENCHMARK_DIR, `benchmark_${BENCH_SIZE}.json`);
const CORPUS_ID = 'fc0213c5-678c-4a79-aef9-c253b5f00c3d';

const NUMBER_WORDS = { zero:'0',one:'1',two:'2',three:'3',four:'4',five:'5',six:'6',seven:'7',eight:'8',nine:'9',ten:'10',eleven:'11',twelve:'12',thirteen:'13',fourteen:'14',fifteen:'15',sixteen:'16',seventeen:'17',eighteen:'18',nineteen:'19',twenty:'20',thirty:'30',forty:'40',fifty:'50',sixty:'60',seventy:'70',eighty:'80',ninety:'90',hundred:'100',thousand:'1000',first:'1st',second:'2nd',third:'3rd',fourth:'4th',fifth:'5th' };
function normalizeAnswer(s) {
  return s.toLowerCase().replace(/\b(a|an|the)\b/g, ' ').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}
function normalizeWithNumbers(s) {
  let norm = normalizeAnswer(s);
  for (const [word, digit] of Object.entries(NUMBER_WORDS)) {
    norm = norm.replace(new RegExp('\\b' + word + '\\b', 'g'), digit);
  }
  return norm;
}
function simpleStem(w) { return w.replace(/(ing|ed|tion|ment|ness|ous|ive|able|ful|less|ly|er|est|ies|es|s)$/,''); }
function normalizedContains(response, answer) {
  if (!response || !answer) return false;
  const cleanResp = response.replace(/\*\*/g, '');
  const normResp = normalizeAnswer(cleanResp);
  const normGold = normalizeAnswer(answer);
  if (normResp.includes(normGold)) return true;
  if (normGold.includes(normResp) && normResp.length >= 3) return true;
  const goldTokens = normGold.split(' ').filter(t => t.length > 1);
  const respTokens = new Set(normResp.split(' '));
  if (goldTokens.length >= 2) {
    const matched = goldTokens.filter(t => respTokens.has(t)).length;
    if (matched >= goldTokens.length * 0.8) return true;
  }
  const numResp = normalizeWithNumbers(cleanResp);
  const numGold = normalizeWithNumbers(answer);
  if (numResp.includes(numGold) || (numGold.includes(numResp) && numResp.length >= 3)) return true;
  const stemGold = normGold.split(' ').map(simpleStem).join(' ');
  const stemResp = normResp.split(' ').map(simpleStem).join(' ');
  if (stemResp.includes(stemGold) || (stemGold.includes(stemResp) && stemResp.length >= 3)) return true;
  return false;
}

async function main() {
  const configPath = resolve(process.cwd(), 'config/default.memgraphrag.yml');
  const baseConfig = loadMemGraphRagConfig(configPath);
  const config = resolveConfigFromEnv(baseConfig);
  const apiKey = resolveApiKey(config.providers.apiKeyFile);

  // aira-graphdb: vector + memory + graph
  const agdbPath = resolve(BENCHMARK_DIR, 'hotpotqa.agdb');
  const agdbClient = new AiraGraphDbNativeClient(agdbPath);
  await agdbClient.request('ping');
  console.log(`[pure-agdb] Connected to ${agdbPath}`);

  const vectorIndex = new AiraGraphDbVectorIndex(agdbClient);
  const memoryStore = new CachedMemoryStore(new AiraGraphDbMemoryStore(agdbClient));
  const graphProjection = new CachedGraphProjection(new AiraGraphDbGraphProjection(agdbClient));

  // Dictionary/Thesaurus: SQLite (same as 88.4% baseline)
  const sqlitePath = resolve(BENCHMARK_DIR, 'hotpotqa.sqlite');
  const db = openDatabase(sqlitePath);
  const dictionary = new SQLiteLexiconStore(db, CORPUS_ID);
  const thesaurus = new SQLiteLexiconStore(db, CORPUS_ID);

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

  const hyperParams = {
    teleportProbability: 0.5,
    scTemperature: 0,
    scSamples: 1,
    hubDegreeThreshold: HP_HUB,
    reasoningEffort: HP_EFFORT,
    verbosity: HP_VERBOSITY,
  };

  // GraphStore needed by VectorMemoryFilter (for getAdjacent)
  const { AiraGraphDbGraphStore } = await import('../dist/infrastructure/index.js');
  const graphStore = new AiraGraphDbGraphStore(agdbClient);

  const queryService = new DefaultQueryService({
    dictionary,
    expansionPolicy: new ThesaurusExpansionPolicy(thesaurus),
    memoryFilter: new VectorMemoryFilter(embedding, vectorIndex, memoryStore, graphStore),
    nodeInitializer: new SimpleNodeInitializer(memoryStore),
    ppr: new SimplePPR(HP_HUB),
    projection: graphProjection,
    contextBuilder: new SimpleContextBuilder(memoryStore),
    llm,
    hyperParams,
  });

  const questions = JSON.parse(readFileSync(QUESTIONS_FILE, 'utf-8'));
  console.log(`\n=== Pure aira-graphdb Benchmark: ${questions.length} questions ===`);
  console.log(`  Vector: AiraGraphDbVectorIndex (passage-only, 7854 vectors)`);
  console.log(`  Memory: AiraGraphDbMemoryStore (113K facts, 9987 passages)`);
  console.log(`  Graph: AiraGraphDbGraphProjection (206K nodes)`);
  console.log(`  Dict/Thesaurus: SQLite`);
  console.log(`  HyperParams: hub=${HP_HUB} K=${HP_TOPK} M=${HP_TOPM} ctx=${HP_CTX} effort=${HP_EFFORT}`);

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
          text: q.question,
          topK: HP_TOPK,
          topM: HP_TOPM,
          threshold: 0.2,
          contextTokenLimit: HP_CTX,
        });
        const isCorrect = normalizedContains(result.response, q.answer);
        return { question: q.question, answer: q.answer, response: result.response, correct: isCorrect, type: q.type };
      } catch (err) {
        return { question: q.question, answer: q.answer, response: `ERROR: ${err.message}`, correct: false, type: q.type };
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
    process.stdout.write(`\r  [${total}/${questions.length}] ${acc}% (${elapsed}s) B:${bridgeTotal?((bridgeCorrect/bridgeTotal)*100).toFixed(0):'?'}% C:${compTotal?((compCorrect/compTotal)*100).toFixed(0):'?'}%   `);
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(0);
  const accuracy = ((correct / total) * 100).toFixed(1);
  console.log(`\n\n=== Results ===`);
  console.log(`  Overall: ${accuracy}% (${correct}/${total})`);
  console.log(`  Bridge: ${bridgeTotal ? ((bridgeCorrect/bridgeTotal)*100).toFixed(1) : 'N/A'}% (${bridgeCorrect}/${bridgeTotal})`);
  console.log(`  Comparison: ${compTotal ? ((compCorrect/compTotal)*100).toFixed(1) : 'N/A'}% (${compCorrect}/${compTotal})`);
  console.log(`  Time: ${totalTime}s (${(totalTime / total).toFixed(1)}s/q)`);
  console.log(`  Backend: PURE aira-graphdb (vector+memory+graph) + SQLite dict`);

  writeFileSync(resolve(BENCHMARK_DIR, 'results_pure_agdb_500.json'), JSON.stringify(results, null, 2));
  
  await agdbClient.close();
  db.close();
}

main().catch(err => { console.error(err); process.exit(1); });
