/**
 * literature-hub #614 — the upsert-only indexing path is unchanged by the
 * replace option.  Uses only APIs that predate #614, so the identical file
 * reproduces the golden trace on production-runtime 080a99e.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AsyncJobRunner } from '../../../src/application/indexing/AsyncJobRunner.js';
import { FullDocumentIndexingPipeline } from '../../../src/application/indexing/FullDocumentIndexingPipeline.js';
import type { IndexDocumentInput } from '../../../src/application/indexing/StageIExtractor.js';
import type { AiraGraphDbTrafficEvent } from '../../../src/infrastructure/storage/aira-graphdb/NativeClient.js';
import { createStorageAdapters } from '../../../src/infrastructure/storage/ladybug/storageFactory.js';
import { openDatabase, runMigrations } from '../../../src/infrastructure/storage/migrate.js';

const CORPUS = 'trace-corpus';

const RELATIONS: Readonly<Record<string, readonly [string, string, string, string, string]>> = {
  a: ['Alcohol', 'HABIT', 'Causes', 'Burns', 'Disease'],
  b: ['Aspirin', 'Drug', 'treats', 'Headache', 'Symptom'],
  c: ['Smoking', 'Habit', 'causes', 'Cancer', 'Disease'],
  d: ['Alcohol', 'Habit', 'CAUSES', 'Cirrhosis', 'disease'],
};

function doc(documentId: string, keys: readonly string[], extra: Record<string, unknown>): IndexDocumentInput {
  return {
    documentId,
    markdown: keys.map((key, index) => `# Section ${index + 1}\n\nPassage relkey_${key} body text ${index + 1}.\n`).join('\n'),
    title: documentId,
    sourceUrl: `https://example.com/${documentId}`,
    sourceType: 'md',
    language: 'en',
    ...extra,
  } as IndexDocumentInput;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Index W, then X, then W again (an upsert-only re-index); return the last job's traffic. */
async function traceReindex(extra: Record<string, unknown>): Promise<readonly string[]> {
  const dir = mkdtempSync(join(tmpdir(), 'aira-graphdb-default-trace-'));
  dirs.push(dir);
  const traffic: AiraGraphDbTrafficEvent[] = [];
  const adapters = await createStorageAdapters({
    backend: 'aira-graphdb',
    airaGraphDb: { dbPath: join(dir, 'graphdb-native.json'), onTraffic: (event) => traffic.push(event) },
  });
  const db = openDatabase(':memory:');
  runMigrations(db);
  db.prepare('INSERT INTO corpora (corpus_id, name, description) VALUES (?, ?, ?)').run(CORPUS, 'Trace', 'default path');
  const pipeline = new FullDocumentIndexingPipeline({
    db,
    graphStore: adapters.graphStore,
    vectorIndex: adapters.vectorIndex,
    indexingMemory: adapters.indexingMemory,
    llmProvider: {
      generate: vi.fn(async ({ prompt }: { prompt: string }) => {
        const relations = [...prompt.matchAll(/relkey_([a-z])/g)].map((match) => {
          const [head, headType, relation, tail, tailType] = RELATIONS[match[1]!]!;
          return { head, headType, relation, tail, tailType, confidence: 0.9 };
        });
        const entities = relations.flatMap((r) => [{ name: r.head, type: r.headType }, { name: r.tail, type: r.tailType }]);
        return { text: JSON.stringify({ entities, relations }), model: 'fake', usage: { inputTokens: 1, outputTokens: 1 } };
      }),
      healthCheck: vi.fn(),
    } as never,
    embeddingProvider: {
      embed: vi.fn(async ({ texts }: { texts: readonly string[] }) => ({
        vectors: texts.map((text) => [1, (text.length % 7) + 1]), model: 'fake', cached: false,
      })),
      healthCheck: vi.fn(),
    } as never,
    nlpExtractor: {
      extract: vi.fn(async () => ({ language: 'en', entities: [], nounPhrases: [] })),
      healthCheck: vi.fn(),
    } as never,
    enableDictionaryIndexing: false,
    ...((adapters as { documentReplace?: unknown }).documentReplace
      ? { documentReplace: (adapters as { documentReplace?: unknown }).documentReplace }
      : {}),
  } as ConstructorParameters<typeof FullDocumentIndexingPipeline>[0]);
  const runner = new AsyncJobRunner(db, adapters.memoryStore, pipeline, adapters.batch);
  const run = async (document: IndexDocumentInput) => {
    const jobId = randomUUID();
    runner.registerJob(jobId, { corpusId: CORPUS, documents: [document] });
    await runner.enqueue(jobId);
    await runner.execute(jobId);
    const row = db.prepare('SELECT status, errors_json FROM jobs WHERE job_id = ?').get(jobId) as { status: string; errors_json: string };
    expect(row).toEqual({ status: 'completed', errors_json: '[]' });
  };
  try {
    await run(doc('doc_w', ['a', 'b'], {}));
    await run(doc('doc_x', ['c'], {}));
    const start = traffic.length;
    await run(doc('doc_w', ['d', 'b'], extra));
    // Method plus exact request size: the byte shape of every RPC.
    return traffic.slice(start).map((event) => `${event.method}:${event.requestBytes}`);
  } finally {
    db.close();
    await adapters.close();
  }
}

describe.sequential('upsert-only indexing path is unchanged without the replace option (literature-hub #614)', () => {
  it('issues the same RPCs, byte for byte, with the option absent or false', async () => {
    const absent = await traceReindex({});
    const disabled = await traceReindex({ replaceExisting: false });
    expect(disabled).toEqual(absent);
    expect(absent.some((entry) => entry.startsWith('memory_delete_document:'))).toBe(false);
    expect(absent.filter((entry) => entry.startsWith('memory_get_schemas_by_ids:'))).toHaveLength(1);
    // Captured by running this file unchanged against the pre-#614 pipeline
    // (aira-synapse production-runtime 080a99e) on aira-graphdb 88db5e0.
    expect(absent).toEqual(GOLDEN_PRE_614_TRACE);
  }, 120_000);
});

const GOLDEN_PRE_614_TRACE: readonly string[] = [
  'memory_load_checkpoint:101',
  'batch_begin:44',
  'memory_get_schemas_by_ids:227',
  'memory_get_active_facts:93',
  'memory_upsert:3317',
  'upsert_nodes:3610',
  'upsert_edges:2572',
  'vector_upsert:1951',
  'memory_save_checkpoint:214',
  'batch_commit:45',
];
