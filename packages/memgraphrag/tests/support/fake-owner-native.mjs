// Fake aira-graphdb native behind a literature-hub owner, for the query-path
// memory-read tests (literature-hub #545). It speaks the native's JSON-line
// protocol, advertises the bounded memory-read inventory, enforces the
// advertised bounds exactly as the native does, and withholds `memory_load`
// the way the owner does for an over-bound corpus. Mutations of the
// advertisement are driven by environment variables so the runtime's
// fail-closed startup can be exercised one defect at a time.
//
//   FAKE_OWNER_STORE                  path to a JSON store {corpusId, passages, facts, schemas, vectors, transitions}
//   FAKE_OWNER_MEMORY_READ_LIMITS     JSON merged over the advertised limits.memoryRead
//   FAKE_OWNER_OMIT_METHODS           comma-separated method names removed from the inventory
//   FAKE_OWNER_MISCLASSIFY_METHOD     one method advertised as {classification: mutation, wal: true}
//   FAKE_OWNER_GENERATION_CHANGE_AFTER  after this many admitted memory reads every further read
//                                     fails with the owner's GENERATION_MISMATCH error
//
// The `fake_events` method returns the request log (method and param sizes);
// `fake_set_generation {generation}` changes the generation protocol_info
// reports, standing in for a commit by the index worker.
// `fake_set_projection {overflow?, transitions?}` makes projection_get_transitions
// fail the way the owner does once the corpus reply outgrows its line bound
// (literature-hub #594), or replaces the transitions it returns.
import { readFileSync } from 'node:fs';
import readline from 'node:readline';

const INDEXING = {
  schema: 'native-indexing-memory@1',
  maxRequestBytes: 64 * 1024 * 1024,
  maxResponseBytes: 8 * 1024 * 1024,
  maxSchemaIds: 4096,
  maxActiveFacts: 100,
  maxDeltaItemsPerSection: 4096,
  maxDomainIdBytes: 4096,
  maxCorpusIdBytes: 1024,
  maxUpdatedAtBytes: 128,
  schemaCanonicalization: {
    schema: 'native-schema-canonicalization@1',
    projection: 'canonicalization@1',
    merge: 'preserve-cas@1',
    graphHydration: 'memory-schema@1',
    maxProjectedSchemas: 32,
    maxSchemaMerges: 32,
    maxGraphHydrations: 32,
    maxAliasAdditions: 4096,
    maxFactIdAdditions: 4096,
    maxSchemaNodeIdBytes: 4103,
    maxSchemaNodeLabelBytes: 12290,
  },
};
const MEMORY_READ = {
  schema: 'native-memory-read@1',
  maxIdsPerRequest: 4096,
  maxEntitiesPerRequest: 64,
  maxLimit: 100,
  ...(process.env.FAKE_OWNER_MEMORY_READ_LIMITS ? JSON.parse(process.env.FAKE_OWNER_MEMORY_READ_LIMITS) : {}),
};
const OMITTED = new Set((process.env.FAKE_OWNER_OMIT_METHODS ?? '').split(',').filter(Boolean));
const MISCLASSIFIED = process.env.FAKE_OWNER_MISCLASSIFY_METHOD;
const GENERATION_CHANGE_AFTER = process.env.FAKE_OWNER_GENERATION_CHANGE_AFTER
  ? Number(process.env.FAKE_OWNER_GENERATION_CHANGE_AFTER)
  : undefined;
const MEMORY_READ_METHODS = [
  'memory_get_passages_by_ids',
  'memory_get_facts_by_ids',
  'memory_find_facts_by_entities',
  'memory_section_counts',
];
const INVENTORY = [
  { name: 'protocol_info', classification: 'read', wal: false },
  { name: 'memory_load', classification: 'read', wal: false },
  { name: 'memory_get_schemas_by_ids', classification: 'read', wal: false },
  { name: 'memory_get_active_facts', classification: 'read', wal: false },
  { name: 'memory_activate_facts_by_schema_ids', classification: 'mutation', wal: true },
  { name: 'memory_upsert', classification: 'mutation', wal: true },
  { name: 'upsert_nodes', classification: 'mutation', wal: true },
  { name: 'vector_search', classification: 'read', wal: false },
  { name: 'projection_get_transitions', classification: 'read', wal: false },
  { name: 'projection_get_node_count', classification: 'read', wal: false },
  { name: 'projection_get_dangling_nodes', classification: 'read', wal: false },
  ...MEMORY_READ_METHODS.map((name) => ({ name, classification: 'read', wal: false })),
]
  .filter((method) => !OMITTED.has(method.name))
  .map((method) => (method.name === MISCLASSIFIED ? { ...method, classification: 'mutation', wal: true } : method));

const store = process.env.FAKE_OWNER_STORE
  ? JSON.parse(readFileSync(process.env.FAKE_OWNER_STORE, 'utf8'))
  : { corpusId: 'fake', passages: [], facts: [], schemas: [], vectors: {}, transitions: [] };
const events = [];
let admittedMemoryReads = 0;
let generation = 7;
let projectionOverflow = false;

class ClientError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fold(value) {
  // The real native folds with the pinned Unicode 16 table; for the fixture
  // alphabet (Latin-1 and Cyrillic letters) toLowerCase agrees with it.
  return value.toLowerCase();
}

function compareCodePoints(left, right) {
  const l = Array.from(left, (c) => c.codePointAt(0));
  const r = Array.from(right, (c) => c.codePointAt(0));
  for (let i = 0; i < Math.min(l.length, r.length); i += 1) {
    if (l[i] !== r[i]) return l[i] < r[i] ? -1 : 1;
  }
  return l.length === r.length ? 0 : (l.length < r.length ? -1 : 1);
}

function exactParams(params, names) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new ClientError('INVALID_REQUEST', 'params must be an object');
  }
  const keys = Object.keys(params).sort();
  if (keys.join(',') !== [...names].sort().join(',')) {
    throw new ClientError('INVALID_REQUEST', `params must be exactly ${names.join(', ')}`);
  }
}

function boundedCorpus(params) {
  const { corpusId } = params;
  if (typeof corpusId !== 'string' || corpusId.length === 0 || Buffer.byteLength(corpusId) > INDEXING.maxCorpusIdBytes) {
    throw new ClientError('INVALID_REQUEST', `corpusId must contain between 1 and ${INDEXING.maxCorpusIdBytes} bytes`);
  }
  if (corpusId !== store.corpusId) return null;
  return store;
}

function boundedIds(params, name, maximum) {
  const items = params[name];
  if (!Array.isArray(items)) throw new ClientError('INVALID_REQUEST', `missing ${name}`);
  if (items.length > maximum) throw new ClientError('INVALID_REQUEST', `${name} length must be in [0, ${maximum}]`);
  const seen = new Set();
  const ids = [];
  for (const item of items) {
    if (typeof item !== 'string' || item.length === 0 || Buffer.byteLength(item) > INDEXING.maxDomainIdBytes) {
      throw new ClientError('INVALID_REQUEST', `${name} must contain only non-empty strings of at most ${INDEXING.maxDomainIdBytes} bytes`);
    }
    if (!seen.has(item)) {
      seen.add(item);
      ids.push(item);
    }
  }
  return ids;
}

function readByIds(params, idsKey, section, idKey, maximum) {
  exactParams(params, ['corpusId', idsKey]);
  const corpus = boundedCorpus(params);
  const ids = boundedIds(params, idsKey, maximum);
  if (!corpus) return [];
  const wanted = new Set(ids);
  const found = new Map();
  for (const item of corpus[section] ?? []) {
    if (!wanted.has(item[idKey])) continue;
    if (found.has(item[idKey])) {
      throw new ClientError('INVALID_REQUEST', `stored ${section} contain a duplicate requested ${idKey}`);
    }
    found.set(item[idKey], item);
  }
  return ids.filter((id) => found.has(id)).map((id) => found.get(id));
}

function guardGeneration(method) {
  if (!MEMORY_READ_METHODS.includes(method) && method !== 'memory_get_schemas_by_ids') return;
  if (GENERATION_CHANGE_AFTER !== undefined && admittedMemoryReads >= GENERATION_CHANGE_AFTER) {
    throw new ClientError(
      'GENERATION_MISMATCH',
      'reader lease generation 7 does not match committed generation 8',
    );
  }
  admittedMemoryReads += 1;
}

function handle(method, params) {
  guardGeneration(method);
  switch (method) {
    case 'protocol_info':
      return {
        protocolVersion: 'native-method-policy@1',
        generation,
        state: 'idle',
        limits: {
          indexingMemory: INDEXING,
          memoryRead: MEMORY_READ,
          wal: { mutationRequestIdUniqueness: 'activeTransaction' },
        },
        methods: INVENTORY,
      };
    case 'memory_load':
      // Mirrors the owner: the whole-corpus reply exceeds the line bound.
      throw new ClientError('NATIVE_LINE_OVERFLOW', 'native reply withheld: memory_load exceeds the line bound');
    case 'memory_get_passages_by_ids':
      return readByIds(params, 'passageIds', 'passages', 'passageId', MEMORY_READ.maxIdsPerRequest);
    case 'memory_get_facts_by_ids':
      return readByIds(params, 'factIds', 'facts', 'factId', MEMORY_READ.maxIdsPerRequest);
    case 'memory_get_schemas_by_ids':
      return readByIds(params, 'schemaIds', 'schemas', 'schemaId', INDEXING.maxSchemaIds);
    case 'memory_find_facts_by_entities': {
      exactParams(params, ['corpusId', 'entities', 'state', 'limit']);
      const corpus = boundedCorpus(params);
      const entities = boundedIds(params, 'entities', MEMORY_READ.maxEntitiesPerRequest);
      if (params.state !== 'active' && params.state !== 'any') {
        throw new ClientError('INVALID_REQUEST', 'state must be "active" or "any"');
      }
      if (!Number.isSafeInteger(params.limit) || params.limit < 0) {
        throw new ClientError('INVALID_REQUEST', 'limit must be a nonnegative integer');
      }
      if (params.limit > MEMORY_READ.maxLimit) {
        throw new ClientError('INVALID_REQUEST', `limit must not exceed ${MEMORY_READ.maxLimit}`);
      }
      if (!corpus || params.limit === 0 || entities.length === 0) return [];
      const wanted = new Set(entities.map(fold));
      return (corpus.facts ?? [])
        .filter((fact) => (params.state === 'any' || fact.state === 'active')
          && (wanted.has(fold(fact.headEntity)) || wanted.has(fold(fact.tailEntity))))
        .sort((left, right) => compareCodePoints(left.factId, right.factId))
        .slice(0, params.limit);
    }
    case 'memory_section_counts': {
      exactParams(params, ['corpusId']);
      const corpus = boundedCorpus(params);
      return {
        passages: corpus?.passages?.length ?? 0,
        facts: corpus?.facts?.length ?? 0,
        schemas: corpus?.schemas?.length ?? 0,
      };
    }
    case 'vector_search': {
      const { corpusId, namespace, queryVector, topK, threshold } = params;
      if (corpusId !== store.corpusId) return [];
      const rows = (store.vectors?.[namespace] ?? []).map((row) => {
        let dot = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < queryVector.length; i += 1) {
          dot += queryVector[i] * row.vector[i];
          normA += queryVector[i] ** 2;
          normB += row.vector[i] ** 2;
        }
        const score = normA === 0 || normB === 0 ? 0 : dot / Math.sqrt(normA * normB);
        return { id: row.id, score, metadata: {} };
      });
      return rows
        .filter((row) => threshold === undefined || row.score >= threshold)
        .sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : 1))
        .slice(0, topK);
    }
    case 'projection_get_transitions':
      if (projectionOverflow) {
        throw new ClientError('NATIVE_LINE_OVERFLOW', 'native graphdb reply exceeds the owner line bound');
      }
      return params.corpusId === store.corpusId ? (store.transitions ?? []) : [];
    case 'projection_get_node_count': {
      const nodes = new Set();
      for (const t of store.transitions ?? []) {
        nodes.add(t.sourceNodeId);
        nodes.add(t.targetNodeId);
      }
      return params.corpusId === store.corpusId ? nodes.size : 0;
    }
    case 'projection_get_dangling_nodes':
      return [];
    case 'fake_events':
      return events;
    case 'fake_set_generation':
      generation = params.generation;
      return null;
    case 'fake_set_projection':
      if (params.overflow !== undefined) projectionOverflow = params.overflow === true;
      if (params.transitions !== undefined) store.transitions = params.transitions;
      return null;
    default:
      throw new ClientError('UNSUPPORTED_METHOD', `unsupported method ${method}`);
  }
}

function summarize(params) {
  if (!params || typeof params !== 'object') return {};
  const summary = {};
  for (const [key, value] of Object.entries(params)) {
    summary[key] = Array.isArray(value) ? value.length : (typeof value === 'string' ? value : typeof value);
  }
  return summary;
}

const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  const request = JSON.parse(line);
  if (!['fake_events', 'fake_set_generation', 'fake_set_projection'].includes(request.method)) {
    events.push({ method: request.method, params: summarize(request.params) });
  }
  let reply;
  try {
    reply = { id: request.id, ok: true, result: handle(request.method, request.params) };
  } catch (error) {
    reply = {
      id: request.id,
      ok: false,
      error: { code: error.code ?? 'INTERNAL', message: error.message },
    };
  }
  process.stdout.write(`${JSON.stringify(reply)}\n`);
});
