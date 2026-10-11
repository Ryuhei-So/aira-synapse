/**
 * literature-hub #614 — per-document replace on the canonical lane against the
 * real aira-graphdb native (memory_delete_document, aira-graphdb 88db5e0+).
 *
 * The pipeline under test is the production FullDocumentIndexingPipeline +
 * AsyncJobRunner over the real native adapters; only the LLM, embedding and
 * NLP providers are deterministic fakes.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AsyncJobRunner,
  DocumentReplaceRefusedError,
} from '../../../src/application/indexing/AsyncJobRunner.js';
import { buildCanonicalizationMemoryDelta } from '../../../src/application/indexing/DocumentMemoryPlan.js';
import {
  FullDocumentIndexingPipeline,
  type FullPipelineOptions,
} from '../../../src/application/indexing/FullDocumentIndexingPipeline.js';
import { StageIICanonicalizer } from '../../../src/application/indexing/StageIICanonicalizer.js';
import type { IndexDocumentInput } from '../../../src/application/indexing/StageIExtractor.js';
import { JOB_ERROR_CONTRACT } from '../../../src/application/indexing/jobErrorContract.js';
import { computeCanonicalKey, type Schema } from '../../../src/domain/memory/schema.js';
import type { ILLMProvider } from '../../../src/domain/provider/llmProvider.js';
import type { IIndexingMemory, ISchemaCanonicalizationMemory } from '../../../src/domain/storage/index.js';
import type { IDocumentReplaceMemory } from '../../../src/domain/storage/documentReplace.js';
import {
  AiraGraphDbNativeClient,
  type AiraGraphDbTrafficEvent,
} from '../../../src/infrastructure/storage/aira-graphdb/NativeClient.js';
import {
  createStorageAdapters,
  type StorageAdapters,
} from '../../../src/infrastructure/storage/ladybug/storageFactory.js';
import { openDatabase, runMigrations } from '../../../src/infrastructure/storage/migrate.js';

const CORPUS = 'replace-corpus';
const W = 'doc_w';
const X = 'doc_x';
const TEST_TIMEOUT = 120_000;

interface Relation {
  readonly head: string;
  readonly headType: string;
  readonly relation: string;
  readonly tail: string;
  readonly tailType: string;
}

/** Each passage names one relation key; the fake LLM answers from this table. */
const RELATIONS: Readonly<Record<string, Relation>> = {
  // W abstract.  W is the first source of the shared schema, through the
  // alias spelling "HABIT Causes Disease".
  w_abs_shared: { head: 'Alcohol', headType: 'HABIT', relation: 'Causes', tail: 'Burns', tailType: 'Disease' },
  w_abs_only: { head: 'Aspirin', headType: 'Drug', relation: 'treats', tail: 'Headache', tailType: 'Symptom' },
  // X shares habit::causes::disease.
  x_shared: { head: 'Smoking', headType: 'Habit', relation: 'causes', tail: 'Cancer', tailType: 'Disease' },
  // W full text: a new alias spelling, the old alias spelling, the W-only schema.
  w_full_shared: { head: 'Alcohol', headType: 'Habit', relation: 'CAUSES', tail: 'Cirrhosis', tailType: 'disease' },
  w_full_old_alias: { head: 'Wine', headType: 'HABIT', relation: 'Causes', tail: 'Gout', tailType: 'Disease' },
  w_full_only: { head: 'Ibuprofen', headType: 'Drug', relation: 'treats', tail: 'Fever', tailType: 'Symptom' },
  // A document that does not exist before its replace.
  z_new: { head: 'Exercise', headType: 'Habit', relation: 'prevents', tail: 'Obesity', tailType: 'Disease' },
};

const SHARED = `schema:${computeCanonicalKey('habit', 'causes', 'disease')}`;
const W_ONLY = `schema:${computeCanonicalKey('drug', 'treats', 'symptom')}`;
/** Ontology graph node and vector id of a schema. */
const node = (schemaId: string) => `schema:${schemaId}`;

function markdown(keys: readonly string[]): string {
  return keys.map((key, index) => `# Section ${index + 1}\n\nPassage relkey_${key} body text ${index + 1}.\n`).join('\n');
}

function doc(documentId: string, keys: readonly string[], extra: Partial<IndexDocumentInput> = {}): IndexDocumentInput {
  return {
    documentId,
    markdown: markdown(keys),
    title: documentId,
    sourceUrl: `https://example.com/${documentId}`,
    sourceType: 'md',
    language: 'en',
    ...extra,
  };
}

function fakeLlm(): ILLMProvider & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    generate: vi.fn(async ({ prompt }: { prompt: string }) => {
      calls.push(prompt);
      const keys = [...prompt.matchAll(/relkey_([a-z_]+)/g)].map((match) => match[1]!);
      const relations = keys.map((key) => {
        const relation = RELATIONS[key];
        if (!relation) throw new Error(`unknown relation key ${key}`);
        return { ...relation, confidence: 0.9 };
      });
      const entities = relations.flatMap((r) => [
        { name: r.head, type: r.headType },
        { name: r.tail, type: r.tailType },
      ]);
      return {
        text: JSON.stringify({ entities, relations }),
        model: 'fake',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }),
    healthCheck: vi.fn(),
  } as unknown as ILLMProvider & { readonly calls: string[] };
}

const embeddingProvider = {
  embed: vi.fn(async ({ texts }: { texts: readonly string[] }) => ({
    vectors: texts.map((text) => [1, (text.length % 7) + 1]),
    model: 'fake',
    cached: false,
  })),
  healthCheck: vi.fn(),
};

const nlpExtractor = {
  extract: vi.fn(async () => ({ language: 'en', entities: [], nounPhrases: [] })),
  healthCheck: vi.fn(),
};

const MUTATIONS = new Set([
  'memory_delete_document', 'memory_upsert', 'memory_activate_facts_by_schema_ids',
  'upsert_nodes', 'upsert_edges', 'vector_upsert', 'memory_save_checkpoint',
]);

interface Harness {
  readonly adapters: StorageAdapters;
  readonly pipeline: FullDocumentIndexingPipeline;
  readonly db: ReturnType<typeof openDatabase>;
  readonly traffic: AiraGraphDbTrafficEvent[];
  readonly llm: ReturnType<typeof fakeLlm>;
  index(documents: readonly IndexDocumentInput[]): Promise<{
    readonly status: string;
    readonly errors: readonly { code: string; documentId?: string; message: string }[];
    readonly thrown?: unknown;
  }>;
  close(): Promise<void>;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDbPath(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `aira-graphdb-replace-${label}-`));
  dirs.push(dir);
  return join(dir, 'graphdb-native.json');
}

async function openHarness(
  dbPath: string,
  override: (adapters: StorageAdapters) => Partial<FullPipelineOptions> = () => ({}),
): Promise<Harness> {
  const traffic: AiraGraphDbTrafficEvent[] = [];
  const adapters = await createStorageAdapters({
    backend: 'aira-graphdb',
    airaGraphDb: { dbPath, onTraffic: (event) => traffic.push(event) },
  });
  if (!adapters.documentReplace) {
    await adapters.close();
    throw new Error('the native under test must advertise memory_delete_document (aira-graphdb 88db5e0+)');
  }
  const db = openDatabase(':memory:');
  runMigrations(db);
  db.prepare('INSERT INTO corpora (corpus_id, name, description) VALUES (?, ?, ?)')
    .run(CORPUS, 'Replace', 'literature-hub #614');
  const llm = fakeLlm();
  const pipeline = new FullDocumentIndexingPipeline({
    db,
    graphStore: adapters.graphStore,
    vectorIndex: adapters.vectorIndex,
    indexingMemory: adapters.indexingMemory,
    llmProvider: llm,
    embeddingProvider: embeddingProvider as never,
    nlpExtractor: nlpExtractor as never,
    enableDictionaryIndexing: false,
    documentReplace: adapters.documentReplace,
    ...override(adapters),
  });
  const runner = new AsyncJobRunner(db, adapters.memoryStore, pipeline, adapters.batch);
  let closed = false;
  return {
    adapters,
    pipeline,
    db,
    traffic,
    llm,
    async index(documents) {
      const jobId = randomUUID();
      runner.registerJob(jobId, { corpusId: CORPUS, documents });
      await runner.enqueue(jobId);
      let thrown: unknown;
      try {
        await runner.execute(jobId);
      } catch (error) {
        thrown = error;
        closed = true;
      }
      const row = db.prepare('SELECT status, errors_json FROM jobs WHERE job_id = ?')
        .get(jobId) as { status: string; errors_json: string };
      return { status: row.status, errors: JSON.parse(row.errors_json), ...(thrown ? { thrown } : {}) };
    },
    async close() {
      db.close();
      if (!closed) await adapters.close();
    },
  };
}

/** A raw client for observation and recovery, opened when no harness is. */
async function withRaw<T>(dbPath: string, fn: (client: AiraGraphDbNativeClient) => Promise<T>): Promise<T> {
  const client = new AiraGraphDbNativeClient(dbPath);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

interface ProtocolInfo {
  readonly state: string;
  readonly generation: number;
  readonly recovery?: { readonly baseGeneration: number; readonly walDigest: string };
}

async function discardRecovery(dbPath: string): Promise<ProtocolInfo> {
  return withRaw(dbPath, async (client) => {
    const info = await client.request<ProtocolInfo>('protocol_info', {});
    expect(info.state).toBe('recoveryPending');
    await client.request('recovery_discard', {
      baseGeneration: info.recovery!.baseGeneration,
      walDigest: info.recovery!.walDigest,
    });
    return client.request<ProtocolInfo>('protocol_info', {});
  });
}

interface Observed {
  readonly generation: number;
  readonly memory: {
    readonly passages: { passageId: string; text: string; metadata: { documentId: string } }[];
    readonly facts: { factId: string; schemaId: string; sourceDocumentIds: string[] }[];
    readonly schemas: { schemaId: string; sourceDocumentIds: string[]; frequency: number; aliases: { label: string }[] }[];
  };
  readonly nodes: { nodeId: string; layer: string; ref: Record<string, unknown> }[];
  readonly edges: { edgeId: string; sourceNodeId: string; targetNodeId: string; relation: string }[];
  readonly vectors: Record<string, { id: string; metadata: Record<string, unknown> }[]>;
}

async function observe(dbPath: string): Promise<Observed> {
  return withRaw(dbPath, async (client) => {
    const info = await client.request<ProtocolInfo>('protocol_info', {});
    expect(info.state).toBe('idle');
    const memory = await client.request<Observed['memory']>('memory_load', { corpusId: CORPUS });
    const nodes = await client.request<Observed['nodes']>('get_nodes', { corpusId: CORPUS });
    const edges = await client.request<Observed['edges']>('get_edges', { corpusId: CORPUS });
    const vectors: Observed['vectors'] = {};
    for (const namespace of ['schema', 'fact', 'passage', 'entity']) {
      const matches = await client.request<{ id: string; metadata: Record<string, unknown> }[]>(
        'vector_search',
        { corpusId: CORPUS, namespace, queryVector: [1, 1], topK: 1000 },
      );
      vectors[namespace] = matches.map(({ id, metadata }) => ({ id, metadata })).sort((a, b) => a.id.localeCompare(b.id));
    }
    const byId = <T>(key: keyof T) => (a: T, b: T) => String(a[key]).localeCompare(String(b[key]));
    return {
      generation: info.generation,
      memory: {
        passages: [...(memory?.passages ?? [])].sort(byId('passageId')),
        facts: [...(memory?.facts ?? [])].sort(byId('factId')),
        schemas: [...(memory?.schemas ?? [])].sort(byId('schemaId')),
      },
      nodes: [...nodes].sort(byId('nodeId')),
      edges: [...edges].sort(byId('edgeId')),
      vectors,
    };
  });
}

const passagesOf = (state: Observed, documentId: string) =>
  state.memory.passages.filter((p) => p.metadata.documentId === documentId);
const factsOf = (state: Observed, documentId: string) =>
  state.memory.facts.filter((f) => f.sourceDocumentIds.includes(documentId));
const schema = (state: Observed, schemaId: string) =>
  state.memory.schemas.find((s) => s.schemaId === schemaId);
const vector = (state: Observed, namespace: string, id: string) =>
  state.vectors[namespace]!.find((v) => v.id === id);
const methods = (traffic: readonly AiraGraphDbTrafficEvent[]) => traffic.map((event) => event.method);

/** W abstract, then X: W is the first source of the shared schema. */
async function seed(dbPath: string): Promise<Observed> {
  const harness = await openHarness(dbPath);
  try {
    expect(await harness.index([doc(W, ['w_abs_shared', 'w_abs_only'])])).toMatchObject({ status: 'completed', errors: [] });
    expect(await harness.index([doc(X, ['x_shared'])])).toMatchObject({ status: 'completed', errors: [] });
  } finally {
    await harness.close();
  }
  const state = await observe(dbPath);
  expect(schema(state, SHARED)?.sourceDocumentIds).toEqual([W, X]);
  expect(vector(state, 'schema', node(SHARED))?.metadata.documentId).toBe(W);
  expect(schema(state, W_ONLY)?.sourceDocumentIds).toEqual([W]);
  return state;
}

/** Find the native process (not the owner fixture wrapper) serving dbPath. */
function nativePid(dbPath: string): number {
  const pids: number[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let argv: string[];
    try {
      argv = readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').filter(Boolean);
    } catch {
      continue;
    }
    if (argv[0] && basename(argv[0]) === 'aira-graphdb-native' && argv.includes(dbPath)) {
      pids.push(Number(entry));
    }
  }
  if (pids.length !== 1) throw new Error(`expected one native for ${dbPath}, found ${pids.length}`);
  return pids[0]!;
}

describe.sequential('aira-graphdb canonical-lane document replace (literature-hub #614)', () => {
  it('replaces abstract with full text in one generation, preserving the shared schema of another document', async () => {
    const dbPath = tempDbPath('main');
    const before = await seed(dbPath);
    const oldWPassages = passagesOf(before, W).map((p) => p.text);
    const oldWFacts = factsOf(before, W).map((f) => f.factId);
    const xFacts = factsOf(before, X).map((f) => f.factId);
    expect(oldWFacts).toHaveLength(2);
    expect(xFacts).toHaveLength(1);

    const harness = await openHarness(dbPath);
    try {
      const result = await harness.index([
        doc(W, ['w_full_shared', 'w_full_old_alias', 'w_full_only'], { replaceExisting: true }),
      ]);
      expect(result).toMatchObject({ status: 'completed', errors: [] });
      const trace = methods(harness.traffic);
      expect(trace.filter((m) => m === 'memory_delete_document')).toHaveLength(1);
      // One projection read before the delete, one inside the batch after it.
      expect(trace.filter((m) => m === 'memory_get_schemas_by_ids')).toHaveLength(2);
      const deleteAt = trace.indexOf('memory_delete_document');
      expect(trace.lastIndexOf('memory_get_schemas_by_ids')).toBeGreaterThan(deleteAt);
      expect(trace.slice(0, deleteAt).filter((m) => MUTATIONS.has(m))).toEqual([]);
      // Only extraction reached the LLM: W's old facts were excluded from
      // conflict detection, so "alcohol causes cirrhosis" did not conflict
      // with its own predecessor "alcohol causes burns".
      expect(harness.llm.calls).toHaveLength(3);
    } finally {
      await harness.close();
    }

    const after = await observe(dbPath);
    expect(after.generation).toBe(before.generation + 1);

    // 0 old passages and 0 old facts of W.
    const newWPassages = passagesOf(after, W).map((p) => p.text);
    expect(newWPassages).toHaveLength(3);
    for (const text of oldWPassages) expect(newWPassages).not.toContain(text);
    const newWFacts = factsOf(after, W).map((f) => f.factId);
    for (const factId of oldWFacts) expect(newWFacts).not.toContain(factId);
    expect(newWFacts).toHaveLength(3);
    for (const factId of oldWFacts) {
      expect(after.nodes.some((n) => n.nodeId.includes(factId))).toBe(false);
      expect(after.vectors.fact!.some((v) => v.id.includes(factId))).toBe(false);
    }
    // Orphaned entities of the old version are gone with their vectors.
    for (const entity of ['burns', 'headache']) {
      expect(after.nodes.some((n) => n.layer === 'entity' && n.nodeId.endsWith(`:${entity}`))).toBe(false);
      expect(after.vectors.entity!.some((v) => v.id.endsWith(`:${entity}`))).toBe(false);
    }

    // X: facts, schema node, schema_instance edges, schema vector re-keyed.
    expect(factsOf(after, X).map((f) => f.factId)).toEqual(xFacts);
    expect(schema(after, SHARED)?.sourceDocumentIds).toEqual([X, W]);
    const sharedNode = after.nodes.find((n) => n.layer === 'ontology' && (n.ref.schemaId === SHARED));
    expect(sharedNode).toBeDefined();
    const xFactNodes = after.nodes.filter((n) => n.layer === 'fact' && xFacts.includes(String(n.ref.factId)));
    expect(xFactNodes).toHaveLength(1);
    expect(after.edges.some((e) => e.relation === 'schema_instance'
      && e.sourceNodeId === sharedNode!.nodeId && e.targetNodeId === xFactNodes[0]!.nodeId)).toBe(true);
    // W was the shared schema's first source: its vector survives, re-keyed to X.
    expect(vector(after, 'schema', sharedNode!.nodeId)?.metadata.documentId).toBe(X);

    // W-only schema: support went to 0 inside the batch (node and vector
    // removed), the in-batch merge restored it; node and vector are back.
    expect(schema(after, W_ONLY)?.sourceDocumentIds).toEqual([W]);
    const wOnlyNode = after.nodes.find((n) => n.layer === 'ontology' && n.ref.schemaId === W_ONLY);
    expect(wOnlyNode).toBeDefined();
    expect(vector(after, 'schema', wOnlyNode!.nodeId)?.metadata.documentId).toBe(W);

    // Alias spellings: the old one survives, the new one is added.
    const aliasLabels = schema(after, SHARED)!.aliases.map((a) => a.label);
    expect(aliasLabels).toEqual(expect.arrayContaining([
      'HABIT Causes Disease', 'Habit causes Disease', 'Habit CAUSES disease',
    ]));
  }, TEST_TIMEOUT);

  it.each([
    ['a schema contributed only by W (support 0 inside the batch)', ['w_full_only'], W_ONLY],
    ['a schema W shares with X where W was the first source', ['w_full_shared'], SHARED],
    ['a schema reached through an alias spelling W contributed before', ['w_full_old_alias'], SHARED],
  ])('commits a replace touching %s', async (_label, keys, schemaId) => {
    const dbPath = tempDbPath('case');
    const before = await seed(dbPath);
    const harness = await openHarness(dbPath);
    try {
      expect(await harness.index([doc(W, keys, { replaceExisting: true })]))
        .toMatchObject({ status: 'completed', errors: [] });
    } finally {
      await harness.close();
    }
    const after = await observe(dbPath);
    expect(after.generation).toBe(before.generation + 1);
    expect(schema(after, schemaId)?.sourceDocumentIds).toContain(W);
    expect(after.nodes.some((n) => n.layer === 'ontology' && n.ref.schemaId === schemaId)).toBe(true);
    expect(vector(after, 'schema', node(schemaId))).toBeDefined();
    expect(passagesOf(after, W)).toHaveLength(keys.length);
  }, TEST_TIMEOUT);

  it('documents why the re-read exists: a merge built from the pre-delete read fails the batch', async () => {
    const dbPath = tempDbPath('stale');
    const before = await seed(dbPath);
    const candidate: Schema = {
      schemaId: SHARED, corpusId: CORPUS, headType: 'habit', relation: 'causes', tailType: 'disease',
      canonicalKey: computeCanonicalKey('habit', 'causes', 'disease'), aliases: [], frequency: 1,
      state: 'pending', stabilizationThreshold: 2, factIds: [], sourceDocumentIds: [W], version: 1,
      createdAt: '2026-10-11T00:00:00.000Z', updatedAt: '2026-10-11T00:00:00.000Z',
    };
    const now = new Date().toISOString();
    const replaceOnce = async (rereadAfterDelete: boolean) => {
      const adapters = await createStorageAdapters({ backend: 'aira-graphdb', airaGraphDb: { dbPath } });
      const stage = new StageIICanonicalizer(CORPUS, adapters.indexingMemory);
      const memory = adapters.indexingMemory as unknown as ISchemaCanonicalizationMemory;
      const stale = await stage.prepareCanonicalSchemas([candidate], W);
      await adapters.batch!.begin();
      await adapters.documentReplace!.memoryDeleteDocument({ corpusId: CORPUS, documentId: W, updatedAt: now });
      const preparation = rereadAfterDelete ? await stage.prepareCanonicalSchemas([candidate], W) : stale;
      const delta = buildCanonicalizationMemoryDelta(
        CORPUS, preparation.schemaViews, preparation.mergeIntents, [], [], now,
      );
      try {
        await memory.upsertSchemaCanonicalizationDelta(delta);
        await adapters.batch!.commit();
        await adapters.close();
        return 'committed';
      } catch (error) {
        await adapters.close().catch(() => undefined);
        return `failed: ${(error as Error).message}`;
      }
    };

    // Stale: W still contributed in the pre-delete read, so the intent says
    // frequencyDelta 0 with a merge token the delete has since changed.
    const staleOutcome = await replaceOnce(false);
    // The native rejects the stale intent (process-fatal, before the WAL).
    expect(staleOutcome).toMatch(/^failed: /);
    expect(staleOutcome).toBe('failed: schema merge token is stale');
    const recovered = await discardRecovery(dbPath);
    expect(recovered.generation).toBe(before.generation);
    expect(await observe(dbPath)).toEqual(before);

    // Fresh: the same intent rebuilt from the in-batch read commits.
    expect(await replaceOnce(true)).toBe('committed');
    const after = await observe(dbPath);
    expect(after.generation).toBe(before.generation + 1);
    expect(schema(after, SHARED)?.sourceDocumentIds).toEqual([X, W]);
  }, TEST_TIMEOUT);

  it.each([
    ['the delta upsert', 'upsert'],
    ['the in-batch projection re-read', 'reread'],
  ])('a failure in %s after the delete never commits and leaves the old version after recovery', async (_label, point) => {
    const dbPath = tempDbPath(`fail-${point}`);
    const before = await seed(dbPath);
    let deleted = false;
    const harness = await openHarness(dbPath, (adapters) => {
      const real = adapters.indexingMemory as IIndexingMemory & ISchemaCanonicalizationMemory;
      const wrapped = new Proxy(real, {
        get(target, property) {
          if (property === 'upsertSchemaCanonicalizationDelta' && point === 'upsert') {
            return async () => { throw new Error('injected delta failure'); };
          }
          if (property === 'getSchemaCanonicalizationProjection' && point === 'reread' ) {
            return async (request: never) => {
              if (deleted) throw new Error('injected re-read failure');
              return target.getSchemaCanonicalizationProjection(request);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const replace: IDocumentReplaceMemory = {
        memoryDeleteDocument: async (request) => {
          const result = await adapters.documentReplace!.memoryDeleteDocument(request);
          deleted = true;
          return result;
        },
      };
      return { indexingMemory: wrapped, documentReplace: replace };
    });
    const result = await harness.index([doc(W, ['w_full_shared', 'w_full_only'], { replaceExisting: true })]);
    await harness.close();
    expect(deleted).toBe(true);
    expect(result.status).toBe('failed');
    expect((result.thrown as Error).name).toBe('DocumentMutationError');
    expect(result.errors).toEqual([expect.objectContaining({ code: JOB_ERROR_CONTRACT.ownerError.code })]);

    const recovered = await discardRecovery(dbPath);
    expect(recovered.generation).toBe(before.generation);
    expect(await observe(dbPath)).toEqual(before);
  }, TEST_TIMEOUT);

  it('a crash between the delete and the commit is discarded on reopen', async () => {
    const dbPath = tempDbPath('crash');
    const before = await seed(dbPath);
    let killed = false;
    const harness = await openHarness(dbPath, (adapters) => ({
      documentReplace: {
        memoryDeleteDocument: async (request) => {
          const result = await adapters.documentReplace!.memoryDeleteDocument(request);
          expect(result.noop).toBe(false);
          process.kill(nativePid(dbPath), 'SIGKILL');
          killed = true;
          return result;
        },
      },
    }));
    const result = await harness.index([doc(W, ['w_full_shared'], { replaceExisting: true })]);
    await harness.close();
    expect(killed).toBe(true);
    expect(result.status).toBe('failed');
    expect((result.thrown as Error).name).toBe('DocumentMutationError');

    const recovered = await discardRecovery(dbPath);
    expect(recovered.generation).toBe(before.generation);
    expect(await observe(dbPath)).toEqual(before);
  }, TEST_TIMEOUT);

  it.each([
    ['the indexing memory has no canonical lane', 'legacy'],
    ['the backend has no memory_delete_document', 'no-delete'],
  ])('refuses a replace when %s before any RPC, LLM call or write', async (_label, variant) => {
    const dbPath = tempDbPath(`refuse-${variant}`);
    const before = await seed(dbPath);
    const harness = await openHarness(dbPath, (adapters) => {
      if (variant === 'no-delete') return { documentReplace: undefined };
      const real = adapters.indexingMemory;
      const legacyOnly: IIndexingMemory = {
        getSchemasByIds: (request) => real.getSchemasByIds(request),
        getActiveFacts: (request) => real.getActiveFacts(request),
        preflightMutation: (plan) => real.preflightMutation(plan),
        activateFactsBySchemaIds: (request) => real.activateFactsBySchemaIds(request),
        upsertDelta: (delta) => real.upsertDelta(delta),
      };
      return { indexingMemory: legacyOnly };
    });
    try {
      const startupTraffic = harness.traffic.length;
      const refused = await harness.pipeline
        .processDocument(CORPUS, doc(W, ['w_full_shared'], { replaceExisting: true }))
        .then(() => undefined, (error: unknown) => error);
      expect(refused).toBeInstanceOf(DocumentReplaceRefusedError);
      expect((refused as DocumentReplaceRefusedError).code).toBe('DOCUMENT_REPLACE_UNSUPPORTED_LANE');
      expect((refused as Error).message).toContain(JOB_ERROR_CONTRACT.replaceRefusedError.message);
      // Not one RPC (read or mutation), no extraction, no sqlite row.
      expect(harness.traffic.length).toBe(startupTraffic);
      expect(harness.llm.calls).toEqual([]);
      expect(harness.db.prepare('SELECT COUNT(*) AS n FROM documents').get()).toEqual({ n: 0 });
    } finally {
      await harness.close();
    }
    expect(await observe(dbPath)).toEqual(before);
  }, TEST_TIMEOUT);

  it('a replace of a document that does not exist yet behaves like an insert', async () => {
    const plainPath = tempDbPath('insert-plain');
    const replacePath = tempDbPath('insert-replace');
    const plain = await seed(plainPath);
    const seeded = await seed(replacePath);

    const runZ = async (dbPath: string, extra: Partial<IndexDocumentInput>) => {
      const harness = await openHarness(dbPath);
      try {
        expect(await harness.index([doc('doc_z', ['z_new'], extra)])).toMatchObject({ status: 'completed', errors: [] });
        return methods(harness.traffic);
      } finally {
        await harness.close();
      }
    };
    const plainTrace = await runZ(plainPath, {});
    const replaceTrace = await runZ(replacePath, { replaceExisting: true });
    expect(replaceTrace.filter((m) => m === 'memory_delete_document')).toHaveLength(1);
    // The noop delete and the in-batch re-read are the only extra RPCs.
    const deleteAt = replaceTrace.indexOf('memory_delete_document');
    const withoutReplaceRpcs = replaceTrace.filter((m, index) => index !== deleteAt
      && !(m === 'memory_get_schemas_by_ids' && index > deleteAt));
    expect(withoutReplaceRpcs).toEqual(plainTrace);

    const plainAfter = await observe(plainPath);
    const replaceAfter = await observe(replacePath);
    expect(replaceAfter.generation).toBe(seeded.generation + 1);
    expect(plainAfter.generation).toBe(plain.generation + 1);
    const shape = (state: Observed) => ({
      passages: state.memory.passages.map((p) => [p.passageId, p.text]),
      facts: state.memory.facts.map((f) => [f.factId, f.sourceDocumentIds]),
      schemas: state.memory.schemas.map((s) => [s.schemaId, s.sourceDocumentIds, s.frequency]),
      nodes: state.nodes.map((n) => n.nodeId),
      edges: state.edges.map((e) => e.edgeId),
      vectors: Object.fromEntries(Object.entries(state.vectors).map(([ns, list]) => [ns, list.map((v) => [v.id, v.metadata.documentId])])),
    });
    expect(shape(replaceAfter)).toEqual(shape(plainAfter));
  }, TEST_TIMEOUT);
});

