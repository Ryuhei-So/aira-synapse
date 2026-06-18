/**
 * Japanese HotpotQA Corpus Indexer — resilient per-document processing
 *
 * Usage:
 *   node scripts/index-ja-corpus.mjs          # Index all (with resume from checkpoint)
 *   node scripts/index-ja-corpus.mjs --reset  # Reset DB and re-index
 *
 * Handles per-document failures gracefully (logs and skips).
 */
import { resolve } from 'node:path';
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createMemGraphRagRuntime, SERVICE_TOKENS } from '../dist/interface/runtime/MemGraphRagRuntime.js';
import { loadMemGraphRagConfig, resolveConfigFromEnv } from '../dist/infrastructure/config/index.js';

const REPO_ROOT = resolve(process.cwd(), '../..');
const JA_DIR = resolve(REPO_ROOT, 'data/benchmark/hotpotqa-ja');
const CORPUS_DIR = resolve(JA_DIR, 'corpus');
const CHECKPOINT_FILE = resolve(JA_DIR, 'index_checkpoint.json');

const RESET = process.argv.includes('--reset');

function loadCheckpoint() {
  if (RESET || !existsSync(CHECKPOINT_FILE)) return { processed: [], failed: [] };
  return JSON.parse(readFileSync(CHECKPOINT_FILE, 'utf-8'));
}

function saveCheckpoint(state) {
  writeFileSync(CHECKPOINT_FILE, JSON.stringify(state, null, 2));
}

async function main() {
  const configPath = resolve(process.cwd(), 'config/hotpotqa-ja.memgraphrag.yml');
  const baseConfig = loadMemGraphRagConfig(configPath);

  const config = resolveConfigFromEnv({
    ...baseConfig,
    providers: {
      ...baseConfig.providers,
      nlp: { ...baseConfig.providers.nlp, backend: 'regex' },
    },
  });

  const runtime = createMemGraphRagRuntime(config);
  await runtime.start();

  const corpusManager = runtime.getService(SERVICE_TOKENS.CORPUS_MANAGER);
  const indexingService = runtime.getService(SERVICE_TOKENS.INDEXING_SERVICE);

  // Ensure corpus exists
  let corpusId;
  const corpusIdFile = resolve(JA_DIR, 'corpus_id.txt');
  if (!RESET && existsSync(corpusIdFile)) {
    corpusId = readFileSync(corpusIdFile, 'utf-8').trim();
    console.log(`Resuming with corpus: ${corpusId}`);
  } else {
    const corpus = await corpusManager.create('HotpotQA-JA', 'Japanese HotpotQA benchmark');
    corpusId = corpus.corpusId;
    writeFileSync(corpusIdFile, corpusId);
    console.log(`Created corpus: ${corpusId}`);
  }

  // Load checkpoint
  const checkpoint = loadCheckpoint();
  const processedSet = new Set(checkpoint.processed);
  const failedList = checkpoint.failed || [];

  // List files
  const files = readdirSync(CORPUS_DIR).filter(f => f.endsWith('.md')).sort();
  const remaining = files.filter(f => !processedSet.has(f));
  console.log(`Total: ${files.length}, Already processed: ${processedSet.size}, Remaining: ${remaining.length}`);

  const startTime = Date.now();
  let successCount = 0;
  let failCount = failedList.length;

  for (let i = 0; i < remaining.length; i++) {
    const file = remaining[i];
    const content = readFileSync(resolve(CORPUS_DIR, file), 'utf-8');
    const title = content.split('\n').find(l => l.startsWith('# '))?.replace(/^#\s*/, '') || file.replace('.md', '');
    const documentId = 'ja_' + file.replace('.md', '');

    const document = {
      documentId,
      markdown: content,
      title,
      sourceUrl: `hotpotqa-ja://${file}`,
      language: 'ja',
      sourceType: 'md',
    };

    try {
      const { jobId } = await indexingService.start({ corpusId, documents: [document] });
      await indexingService.resume(jobId);
      successCount++;
      processedSet.add(file);

      if ((successCount % 10) === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const rate = (successCount / (elapsed / 60)).toFixed(1);
        console.log(`  [${processedSet.size}/${files.length}] ${rate} docs/min — ${title}`);
        saveCheckpoint({ processed: [...processedSet], failed: failedList });
      }
    } catch (err) {
      failCount++;
      failedList.push({ file, error: err.message?.substring(0, 200) });
      console.error(`  ✗ FAILED: ${file} — ${err.message?.substring(0, 100)}`);
      processedSet.add(file); // Mark as processed (skip on resume)
    }
  }

  // Final checkpoint
  saveCheckpoint({ processed: [...processedSet], failed: failedList });

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n=== Indexing Complete ===`);
  console.log(`  Time: ${elapsed} min`);
  console.log(`  Success: ${successCount}, Failed: ${failCount}`);
  console.log(`  Total processed: ${processedSet.size}/${files.length}`);

  try {
    const stats = await corpusManager.getStats(corpusId);
    console.log(`  Nodes: ${stats?.nodeCount ?? 'N/A'}, Edges: ${stats?.edgeCount ?? 'N/A'}`);
  } catch { /* ignore */ }

  process.exit(0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
