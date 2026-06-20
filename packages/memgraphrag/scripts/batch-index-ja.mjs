/**
 * Batch API Indexer for JA HotpotQA Corpus
 *
 * Uses OpenAI Batch API (50% cost reduction). Model is read from config.
 *
 * Workflow:
 *   1. Prepare: chunk all docs → generate JSONL batch file
 *      node scripts/batch-index-ja.mjs prepare
 *
 *   2. Submit: upload JSONL and submit batch job
 *      node scripts/batch-index-ja.mjs submit
 *
 *   3. Status: check batch job status
 *      node scripts/batch-index-ja.mjs status
 *
 *   4. Download: download results and ingest into Neo4j/graph
 *      node scripts/batch-index-ja.mjs download
 *
 *   5. Ingest: process downloaded results into graph store
 *      node scripts/batch-index-ja.mjs ingest
 */
import { resolve } from 'node:path';
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync, createReadStream } from 'node:fs';
import { loadMemGraphRagConfig, resolveConfigFromEnv, resolveApiKey } from '../dist/infrastructure/config/index.js';
import { chunkMarkdownDocument, estimateTokens } from '../dist/application/indexing/MarkdownChunker.js';
import { detectLanguage } from '../dist/domain/language/index.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const JA_DIR = resolve(REPO_ROOT, 'data/benchmark/hotpotqa-ja');
const CORPUS_DIR = resolve(JA_DIR, 'corpus');
const BATCH_DIR = resolve(JA_DIR, 'batch');

// Load config and API key
const configPath = resolve(import.meta.dirname, '..', 'config/hotpotqa-ja.memgraphrag.yml');
const baseConfig = loadMemGraphRagConfig(configPath);
const config = resolveConfigFromEnv(baseConfig);
const API_KEY = resolveApiKey(config.providers.apiKeyFile);

const MODEL = config.providers.llm.model;
const MAX_TOKENS = config.providers.llm.maxTokens || 2000;
const TEMPERATURE = config.providers.llm.temperature ?? 0.1;

// JA extraction prompt (same as LLMExtractionAgent)
const EXTRACTION_PROMPT_JA = `あなたは知識グラフ抽出エージェントです。与えられたテキストから、できるだけ多くの構造化知識を抽出してください。

以下のJSON形式で返してください:
- "entities": 配列 { "name": string, "type": string } — テキスト中の固有名詞・概念
- "relations": 配列 { "head": string, "headType": string, "relation": string, "tail": string, "tailType": string, "confidence": number } — エンティティ間の事実関係

ルール:
1. エンティティ型: "人物", "組織", "場所", "作品", "イベント", "概念", "日時", "数値", "方法", "技術"
2. 関係は動詞句: "は", "に所属する", "で生まれた", "を制作した", "に位置する", "で活動した", "と共演した", "を受賞した", "に分類される", "の別名である", "と比較される", "を設立した", "に参加した", "で公開された", "から派生した"
3. テキストに明示された事実のみ抽出（推測は不可）
4. **最低15個以上のrelationsを抽出すること**。テキストのあらゆる事実を漏れなく捉えてください
5. 人名、地名、作品名、組織名は原文のまま抽出（翻訳しない）
6. 同じエンティティの別表記（略称、英語名等）も別のrelationとして抽出: "の別名である"
7. 数値情報（年号、人数、金額等）もエンティティとして抽出
8. confidence は 0.5-1.0（明確さに応じて）
9. 有効なJSONのみ返す（マークダウンフェンス不要）

テキスト:
`;

// =========== COMMANDS ===========

async function prepare() {
  mkdirSync(BATCH_DIR, { recursive: true });

  const files = readdirSync(CORPUS_DIR).filter(f => f.endsWith('.md')).sort();
  console.log(`Corpus: ${files.length} files`);

  const requests = [];
  let totalChunks = 0;

  for (const file of files) {
    const docId = file.replace('.md', '');
    const markdown = readFileSync(resolve(CORPUS_DIR, file), 'utf-8');

    const chunks = chunkMarkdownDocument({
      corpusId: 'hotpotqa-ja',
      documentId: docId,
      title: docId,
      sourceUrl: '',
      markdown,
      language: 'ja',
    });

    for (const chunk of chunks) {
      const customId = `${docId}::${chunk.chunkIndex}`;
      requests.push({
        custom_id: customId,
        method: 'POST',
        url: '/v1/chat/completions',
        body: {
          model: MODEL,
          messages: [
            { role: 'system', content: 'You are a knowledge graph extraction agent. Respond with valid JSON only.' },
            { role: 'user', content: EXTRACTION_PROMPT_JA + chunk.normalizedText.slice(0, 3000) },
          ],
          max_completion_tokens: MAX_TOKENS,
          temperature: TEMPERATURE,
          response_format: { type: 'json_object' },
        },
      });
      totalChunks++;
    }
  }

  // Write JSONL
  const jsonlPath = resolve(BATCH_DIR, 'extraction_requests.jsonl');
  const lines = requests.map(r => JSON.stringify(r));
  writeFileSync(jsonlPath, lines.join('\n') + '\n');

  // Estimate cost
  const avgInputTokens = 2000;
  const avgOutputTokens = 1500;
  const inputCost = (totalChunks * avgInputTokens / 1_000_000) * 0.20 * 0.5; // gpt-4.1-mini batch input
  const outputCost = (totalChunks * avgOutputTokens / 1_000_000) * 0.80 * 0.5; // gpt-4.1-mini batch output

  console.log(`\nPrepared ${totalChunks} extraction requests from ${files.length} documents`);
  console.log(`Output: ${jsonlPath}`);
  console.log(`File size: ${(Buffer.byteLength(lines.join('\n')) / 1024 / 1024).toFixed(1)} MB`);
  console.log(`\nEstimated cost (Batch 50% discount):`);
  console.log(`  Input:  ${totalChunks} × ~${avgInputTokens} tokens = ~$${inputCost.toFixed(2)}`);
  console.log(`  Output: ${totalChunks} × ~${avgOutputTokens} tokens = ~$${outputCost.toFixed(2)}`);
  console.log(`  Total:  ~$${(inputCost + outputCost).toFixed(2)}`);

  // Save metadata
  writeFileSync(resolve(BATCH_DIR, 'metadata.json'), JSON.stringify({
    model: MODEL,
    totalDocs: files.length,
    totalChunks,
    createdAt: new Date().toISOString(),
  }, null, 2));
}

async function submit() {
  const jsonlPath = resolve(BATCH_DIR, 'extraction_requests.jsonl');
  if (!existsSync(jsonlPath)) {
    console.error('No requests file found. Run "prepare" first.');
    process.exit(1);
  }

  console.log('Uploading batch file...');

  // Step 1: Upload file
  const formData = new FormData();
  const fileContent = readFileSync(jsonlPath);
  formData.append('file', new Blob([fileContent]), 'extraction_requests.jsonl');
  formData.append('purpose', 'batch');

  const uploadRes = await fetch('https://api.openai.com/v1/files', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${API_KEY}` },
    body: formData,
  });

  if (!uploadRes.ok) {
    const err = await uploadRes.json();
    console.error('Upload failed:', err);
    process.exit(1);
  }

  const uploadData = await uploadRes.json();
  console.log(`File uploaded: ${uploadData.id} (${(uploadData.bytes / 1024 / 1024).toFixed(1)} MB)`);

  // Step 2: Create batch
  const batchRes = await fetch('https://api.openai.com/v1/batches', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input_file_id: uploadData.id,
      endpoint: '/v1/chat/completions',
      completion_window: '24h',
      metadata: { description: 'MemGraphRAG JA HotpotQA extraction' },
    }),
  });

  if (!batchRes.ok) {
    const err = await batchRes.json();
    console.error('Batch creation failed:', err);
    process.exit(1);
  }

  const batchData = await batchRes.json();
  console.log(`\nBatch created: ${batchData.id}`);
  console.log(`Status: ${batchData.status}`);

  // Save batch info
  writeFileSync(resolve(BATCH_DIR, 'batch_info.json'), JSON.stringify(batchData, null, 2));
  console.log(`\nSaved batch info to ${resolve(BATCH_DIR, 'batch_info.json')}`);
  console.log('Run "node scripts/batch-index-ja.mjs status" to check progress.');
}

async function status() {
  const infoPath = resolve(BATCH_DIR, 'batch_info.json');
  if (!existsSync(infoPath)) {
    console.error('No batch info found. Run "submit" first.');
    process.exit(1);
  }

  const info = JSON.parse(readFileSync(infoPath, 'utf-8'));
  const res = await fetch(`https://api.openai.com/v1/batches/${info.id}`, {
    headers: { 'Authorization': `Bearer ${API_KEY}` },
  });

  if (!res.ok) {
    const err = await res.json();
    console.error('Status check failed:', err);
    process.exit(1);
  }

  const data = await res.json();
  console.log(`Batch: ${data.id}`);
  console.log(`Status: ${data.status}`);
  console.log(`Created: ${new Date(data.created_at * 1000).toISOString()}`);
  if (data.in_progress_at) console.log(`Started: ${new Date(data.in_progress_at * 1000).toISOString()}`);
  if (data.completed_at) console.log(`Completed: ${new Date(data.completed_at * 1000).toISOString()}`);

  const counts = data.request_counts || {};
  console.log(`\nRequests: ${counts.total || 0} total, ${counts.completed || 0} completed, ${counts.failed || 0} failed`);

  if (data.output_file_id) {
    console.log(`\nOutput file ready: ${data.output_file_id}`);
    console.log('Run "node scripts/batch-index-ja.mjs download" to get results.');
  }

  // Update local info
  writeFileSync(infoPath, JSON.stringify(data, null, 2));
}

async function download() {
  const infoPath = resolve(BATCH_DIR, 'batch_info.json');
  if (!existsSync(infoPath)) {
    console.error('No batch info found.');
    process.exit(1);
  }

  const info = JSON.parse(readFileSync(infoPath, 'utf-8'));

  // Refresh status
  const statusRes = await fetch(`https://api.openai.com/v1/batches/${info.id}`, {
    headers: { 'Authorization': `Bearer ${API_KEY}` },
  });
  const statusData = await statusRes.json();

  if (statusData.status !== 'completed') {
    console.error(`Batch not completed yet. Status: ${statusData.status}`);
    process.exit(1);
  }

  if (!statusData.output_file_id) {
    console.error('No output file available.');
    process.exit(1);
  }

  console.log(`Downloading output file: ${statusData.output_file_id}...`);

  const fileRes = await fetch(`https://api.openai.com/v1/files/${statusData.output_file_id}/content`, {
    headers: { 'Authorization': `Bearer ${API_KEY}` },
  });

  if (!fileRes.ok) {
    console.error('Download failed:', await fileRes.text());
    process.exit(1);
  }

  const content = await fileRes.text();
  const outputPath = resolve(BATCH_DIR, 'extraction_results.jsonl');
  writeFileSync(outputPath, content);

  const lines = content.trim().split('\n');
  console.log(`Downloaded ${lines.length} results to ${outputPath}`);

  // Also download error file if exists
  if (statusData.error_file_id) {
    const errRes = await fetch(`https://api.openai.com/v1/files/${statusData.error_file_id}/content`, {
      headers: { 'Authorization': `Bearer ${API_KEY}` },
    });
    if (errRes.ok) {
      const errContent = await errRes.text();
      writeFileSync(resolve(BATCH_DIR, 'extraction_errors.jsonl'), errContent);
      console.log(`Errors saved to extraction_errors.jsonl`);
    }
  }

  console.log('\nRun "node scripts/batch-index-ja.mjs ingest" to process results.');
}


async function ingest() {
  const resultsPath = resolve(BATCH_DIR, 'extraction_results.jsonl');
  if (!existsSync(resultsPath)) {
    console.error('No results file. Run "download" first.');
    process.exit(1);
  }

  // Use Neo4j for graph storage
  const { createNeo4jAdapters } = await import('../dist/infrastructure/storage/ladybug/storageFactory.js');
  const { projectGraph, upsertVectors } = await import('../dist/application/indexing/StageIVGraphProjector.js');
  const { OpenAIEmbeddingProvider } = await import('../dist/infrastructure/embedding/OpenAIEmbeddingProvider.js');

  const NEO4J_URI = process.env.NEO4J_URI || 'bolt://localhost:7687';
  const NEO4J_USER = process.env.NEO4J_USER || 'neo4j';
  const NEO4J_PASS = process.env.NEO4J_PASS || 'memgraphrag';
  const NEO4J_DB = process.env.NEO4J_DB || 'neo4j';

  console.log(`Connecting to Neo4j: ${NEO4J_URI}`);
  const adapters = await createNeo4jAdapters({
    uri: NEO4J_URI,
    username: NEO4J_USER,
    password: NEO4J_PASS,
    database: NEO4J_DB,
  });
  let { graphStore, vectorIndex, memoryStore } = adapters;

  // Embedding provider
  const embeddingProvider = new OpenAIEmbeddingProvider({
    apiKey: API_KEY,
    model: config.providers.embedding.model,
    dimensions: config.providers.embedding.dimensions || 3072,
  });

  // Corpus ID
  const corpusIdFile = resolve(JA_DIR, 'corpus_id.txt');
  let corpusId;
  if (existsSync(corpusIdFile)) {
    corpusId = readFileSync(corpusIdFile, 'utf-8').trim();
  } else {
    corpusId = crypto.randomUUID();
    writeFileSync(corpusIdFile, corpusId);
  }
  console.log(`Corpus: ${corpusId}`);

  // Parse results
  const lines = readFileSync(resultsPath, 'utf-8').trim().split('\n');
  console.log(`Processing ${lines.length} extraction results...`);

  function parsePartialJson(text) {
    const entities = [];
    const relations = [];
    for (const m of text.matchAll(/\{"name":\s*"([^"]+)",\s*"type":\s*"([^"]+)"\}/g)) {
      entities.push({ name: m[1], type: m[2] });
    }
    for (const m of text.matchAll(/\{"head":\s*"([^"]+)",\s*"headType":\s*"([^"]+)",\s*"relation":\s*"([^"]+)",\s*"tail":\s*"([^"]+)",\s*"tailType":\s*"([^"]+)",\s*"confidence":\s*([0-9.]+)\}/g)) {
      relations.push({ head: m[1], headType: m[2], relation: m[3], tail: m[4], tailType: m[5], confidence: parseFloat(m[6]) });
    }
    return { entities, relations };
  }

  // Group by document
  const docResults = new Map();
  let parsed = 0, partialParsed = 0, failed = 0;
  for (const line of lines) {
    const result = JSON.parse(line);
    const customId = result.custom_id;
    const [docId, chunkIdxStr] = customId.split('::');
    const chunkIndex = parseInt(chunkIdxStr, 10);

    if (result.response?.status_code !== 200) { failed++; continue; }
    const content = result.response.body?.choices?.[0]?.message?.content;
    if (!content) { failed++; continue; }

    const cleaned = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    let data;
    try {
      data = JSON.parse(cleaned);
      parsed++;
    } catch {
      data = parsePartialJson(cleaned);
      if (data.relations.length > 0) { partialParsed++; }
      else { failed++; continue; }
    }

    if (!docResults.has(docId)) docResults.set(docId, []);
    docResults.get(docId).push({
      chunkIndex,
      entities: Array.isArray(data.entities) ? data.entities : [],
      relations: Array.isArray(data.relations) ? data.relations : [],
    });
  }

  console.log(`Parsed: ${parsed}, Partial: ${partialParsed}, Failed: ${failed}`);
  console.log(`Documents with results: ${docResults.size}`);

  const now = new Date().toISOString();
  const normalizeEntity = (name) => name.trim().replace(/\s+/g, ' ');

  // Resume support: skip already-processed docs
  const processedPath = resolve(BATCH_DIR, 'processed_docs.json');
  const alreadyProcessed = existsSync(processedPath)
    ? new Set(JSON.parse(readFileSync(processedPath, 'utf-8')))
    : new Set();
  if (alreadyProcessed.size > 0) {
    console.log(`Resuming: skipping ${alreadyProcessed.size} already-processed docs`);
  }

  let docCount = 0;
  let skipped = 0;
  let newProcessed = 0;
  const totalDocs = docResults.size;
  let totalFacts = 0;
  let totalPassages = 0;

  for (const [docId, chunks] of docResults) {
    docCount++;
    if (alreadyProcessed.has(docId)) { skipped++; continue; }
    newProcessed++;

    if (newProcessed % 50 === 0) {
      console.log(`  [${docCount}/${totalDocs}] Processing ${docId}... (new: ${newProcessed})`);
      writeFileSync(processedPath, JSON.stringify([...alreadyProcessed]));
    }

    const mdPath = resolve(CORPUS_DIR, `${docId}.md`);
    if (!existsSync(mdPath)) continue;
    const markdown = readFileSync(mdPath, 'utf-8');

    const docChunks = chunkMarkdownDocument({
      corpusId,
      documentId: docId,
      title: docId,
      sourceUrl: '',
      markdown,
      language: 'ja',
    });

    const allRelations = [];
    for (const chunk of chunks) {
      allRelations.push(...chunk.relations);
    }

    // Build schemas
    const schemaMap = new Map();
    for (const r of allRelations) {
      const key = `${r.headType}|${r.relation}|${r.tailType}`;
      if (!schemaMap.has(key)) {
        schemaMap.set(key, {
          schemaId: `schema:${corpusId}:${key.replace(/[^a-zA-Z0-9\u3000-\u9fff]/g, '_')}`,
          corpusId,
          headType: r.headType,
          relation: r.relation,
          tailType: r.tailType,
          canonicalKey: key,
          frequency: 0,
          state: 'stable',
          stabilizationThreshold: 3,
          version: 1,
          sourceDocumentIds: [docId],
          aliases: [],
          createdAt: now,
          updatedAt: now,
        });
      }
      schemaMap.get(key).frequency++;
    }

    // Build facts
    const facts = allRelations.map((r, i) => {
      const schemaKey = `${r.headType}|${r.relation}|${r.tailType}`;
      const schema = schemaMap.get(schemaKey);
      const passageIdx = Math.min(
        Math.floor(i / Math.max(1, Math.ceil(allRelations.length / docChunks.length))),
        docChunks.length - 1,
      );
      return {
        factId: `${docId}:f${i}`,
        corpusId,
        schemaId: schema.schemaId,
        headEntity: normalizeEntity(r.head),
        headType: r.headType,
        relation: r.relation,
        tailEntity: normalizeEntity(r.tail),
        tailType: r.tailType,
        state: 'active',
        passageIds: [`${docId}:${passageIdx}`],
        sourceDocumentIds: [docId],
        confidence: r.confidence || 0.8,
        createdAt: now,
        updatedAt: now,
      };
    });

    // Build passages
    const passages = docChunks.map((chunk, idx) => ({
      passageId: `${docId}:${idx}`,
      corpusId,
      text: chunk.text,
      normalizedText: chunk.normalizedText,
      sectionPath: chunk.sectionPath.join(' > '),
      chunkId: chunk.chunkId,
      chunkIndex: idx,
      offsetStart: chunk.offsetStart,
      offsetEnd: chunk.offsetEnd,
      entityMentions: [],
      qualityFlags: [],
      qualityScore: 1.0,
      metadata: {
        documentId: docId,
        title: docId,
        sourceUrl: '',
        language: 'ja',
      },
      createdAt: now,
      updatedAt: now,
    }));

    const schemas = [...schemaMap.values()];
    try {
      await memoryStore.save({
        corpusId,
        exportedAt: now,
        schemas,
        facts,
        passages,
        schemaVersion: 1,
      });

      await projectGraph(graphStore, facts, schemas, passages);

      totalFacts += facts.length;
      totalPassages += passages.length;
      alreadyProcessed.add(docId);
    } catch (err) {
      console.error(`  Error processing ${docId}:`, err.message);
    }
  }

  // Save checkpoint
  writeFileSync(processedPath, JSON.stringify([...alreadyProcessed]));
  console.log(`\nNeo4j write complete: ${totalFacts} new facts, ${totalPassages} new passages (skipped ${skipped} docs)`);
  console.log(`Total processed docs: ${alreadyProcessed.size}`);

  // Generate embeddings (Neo4j keeps connection alive — no reopen needed)
  console.log('Generating embeddings...');
  const allPassageNodes = [];
  for (const [docId] of docResults) {
    const mdPath = resolve(CORPUS_DIR, `${docId}.md`);
    if (!existsSync(mdPath)) continue;
    const markdown = readFileSync(mdPath, 'utf-8');
    const docChunks = chunkMarkdownDocument({
      corpusId,
      documentId: docId,
      title: docId,
      sourceUrl: '',
      markdown,
      language: 'ja',
    });
    for (let idx = 0; idx < docChunks.length; idx++) {
      allPassageNodes.push({
        nodeId: `${docId}:${idx}`,
        corpusId,
        layer: 'passage',
        ref: { passageId: `${docId}:${idx}` },
        label: docChunks[idx].text,
      });
    }
  }

  const EMBED_BATCH = 32;
  const MAX_EMBED_CHARS = 4000; // Conservative: Japanese can be ~2 tokens/char
  let embeddedCount = 0;
  // Filter out empty labels and truncate overly long ones
  const validNodes = allPassageNodes
    .filter(n => n.label && n.label.trim().length > 0)
    .map(n => ({
      ...n,
      label: n.label.length > MAX_EMBED_CHARS ? n.label.slice(0, MAX_EMBED_CHARS) : n.label,
    }));
  console.log(`  Total passage nodes: ${allPassageNodes.length}, valid for embedding: ${validNodes.length}`);
  for (let i = 0; i < validNodes.length; i += EMBED_BATCH) {
    const batch = validNodes.slice(i, i + EMBED_BATCH);
    await upsertVectors(vectorIndex, embeddingProvider, batch);
    embeddedCount += batch.length;
    if (embeddedCount % 500 === 0 || i + EMBED_BATCH >= validNodes.length) {
      console.log(`  Embedded ${embeddedCount}/${validNodes.length}`);
    }
  }

  console.log(`\nIngest complete!`);
  console.log(`  Documents: ${docResults.size}`);
  console.log(`  Facts: ${totalFacts}`);
  console.log(`  Passages: ${totalPassages}`);
  console.log(`  Embeddings: ${embeddedCount}`);

  await adapters.close();
}

// =========== MAIN ===========
const command = process.argv[2];

switch (command) {
  case 'prepare':
    await prepare();
    break;
  case 'submit':
    await submit();
    break;
  case 'status':
    await status();
    break;
  case 'download':
    await download();
    break;
  case 'ingest':
    await ingest();
    break;
  default:
    console.log(`Usage: node scripts/batch-index-ja.mjs <command>

Commands:
  prepare   Chunk documents and create JSONL batch file
  submit    Upload JSONL and submit batch job to OpenAI
  status    Check batch job status
  download  Download completed results
  ingest    Process results into graph store + embeddings
`);
}
