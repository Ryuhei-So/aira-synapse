/**
 * Query test script for the 100-paper GraphRAG corpus.
 * Usage: node scripts/query-test.mjs
 */
import { resolve } from 'node:path';
import { createMemGraphRagRuntime, SERVICE_TOKENS } from '../dist/interface/runtime/MemGraphRagRuntime.js';
import { loadMemGraphRagConfig, resolveConfigFromEnv } from '../dist/infrastructure/config/index.js';

const CORPUS_ID = 'e42ce314-11b1-4769-9580-5856b7c8525a';

const queries = [
  'What is GraphRAG and how does it compare to traditional RAG?',
  'What are the main approaches for knowledge graph construction from text?',
  'How does community detection improve retrieval augmented generation?',
  'What role does Personalized PageRank play in graph-based retrieval?',
  'What are the limitations of current graph-based RAG systems?',
];

async function main() {
  const configPath = resolve(process.cwd(), 'packages/memgraphrag/config/default.memgraphrag.yml');
  const config = resolveConfigFromEnv(loadMemGraphRagConfig(configPath));
  const runtime = createMemGraphRagRuntime(config);
  await runtime.start();

  const queryService = runtime.getService(SERVICE_TOKENS.QUERY_SERVICE);
  
  for (const queryText of queries) {
    console.log('\n' + '='.repeat(80));
    console.log(`QUERY: ${queryText}`);
    console.log('='.repeat(80));
    
    const startTime = Date.now();
    try {
      const result = await queryService.query({
        corpusId: CORPUS_ID,
        text: queryText,
        topK: 10,
        topM: 20,
        threshold: 0.3,
        contextTokenLimit: 4000,
      });
      
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      
      console.log(`\n--- Response (${elapsed}s) ---`);
      console.log(result.response.slice(0, 1000));
      if (result.response.length > 1000) console.log('... [truncated]');
      
      console.log(`\n--- Metrics ---`);
      console.log(`  Dictionary matches: ${result.metrics.dictionaryMatchCount}`);
      console.log(`  Expanded terms: ${result.metrics.expandedTerms.join(', ') || 'none'}`);
      console.log(`  PPR iterations: ${result.metrics.pprIterations} (converged: ${result.metrics.pprConverged})`);
      console.log(`  Cited passages: ${result.metrics.citedPassageCount}`);
      console.log(`  Fallback triggered: ${result.metrics.fallbackTriggered}`);
      console.log(`  LLM tokens: input=${result.metrics.llmInputTokens}, output=${result.metrics.llmOutputTokens}`);
      
      if (result.citations.length > 0) {
        console.log(`\n--- Citations (${result.citations.length}) ---`);
        for (const cite of result.citations.slice(0, 3)) {
          console.log(`  [${cite.passageId}] ${cite.title}`);
          console.log(`    ${cite.snippet.slice(0, 120)}...`);
        }
      }
      
      if (result.entities.length > 0) {
        console.log(`\n--- Entities (${result.entities.length}) ---`);
        for (const entity of result.entities.slice(0, 5)) {
          console.log(`  ${entity.term} (boost: ${entity.boostFactor})`);
        }
      }
    } catch (error) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.error(`\n--- ERROR (${elapsed}s) ---`);
      console.error(error instanceof Error ? `${error.message}\n${error.stack}` : String(error));
    }
  }
  
  await runtime.shutdown();
}

main().catch(console.error);
