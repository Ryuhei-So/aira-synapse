// Fake aira-graphdb-native for transport tests: answers every request with a
// reply whose size is controlled by the request params, and counts calls so
// tests can prove a projection is pulled once, not per query.
import readline from 'node:readline';

const calls = new Map();
const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  const request = JSON.parse(line);
  calls.set(request.method, (calls.get(request.method) ?? 0) + 1);
  let result = null;
  if (request.method === 'huge') {
    // One reply line of `bytes` ASCII characters inside a JSON string.
    result = 'a'.repeat(Number(request.params?.bytes ?? 0));
  } else if (request.method === 'projection_get_transitions') {
    const count = Number(process.env.FAKE_TRANSITIONS ?? 3);
    result = Array.from({ length: count }, (_, i) => ({
      sourceNodeId: `entity:${i}`,
      targetNodeId: `passage:${i}`,
      weight: 1,
    }));
  } else if (request.method === 'projection_get_node_count') {
    result = Number(process.env.FAKE_TRANSITIONS ?? 3) * 2;
  } else if (request.method === 'projection_get_dangling_nodes') {
    result = [];
  } else if (request.method === 'calls') {
    result = Object.fromEntries(calls);
  } else if (request.method === 'protocol_info') {
    // The adapters validate the bounded indexing inventory at startup.
    result = {
      protocolVersion: 'native-method-policy@1',
      generation: 0,
      state: 'idle',
      limits: {
        indexingMemory: {
          schema: 'native-indexing-memory@1',
          maxRequestBytes: 64 * 1024 * 1024,
          maxResponseBytes: 8 * 1024 * 1024,
          maxSchemaIds: 4096,
          maxActiveFacts: 100,
          maxDeltaItemsPerSection: 4096,
          maxDomainIdBytes: 4096,
          maxCorpusIdBytes: 1024,
          maxUpdatedAtBytes: 128,
        },
        memoryRead: {
          schema: 'native-memory-read@1',
          maxIdsPerRequest: 4096,
          maxEntitiesPerRequest: 64,
          maxLimit: 100,
        },
        wal: { mutationRequestIdUniqueness: 'activeTransaction' },
      },
      methods: [
        { name: 'memory_get_schemas_by_ids', classification: 'read', wal: false },
        { name: 'memory_get_active_facts', classification: 'read', wal: false },
        { name: 'memory_activate_facts_by_schema_ids', classification: 'mutation', wal: true },
        { name: 'memory_upsert', classification: 'mutation', wal: true },
        { name: 'memory_get_passages_by_ids', classification: 'read', wal: false },
        { name: 'memory_get_facts_by_ids', classification: 'read', wal: false },
        { name: 'memory_find_facts_by_entities', classification: 'read', wal: false },
        { name: 'memory_section_counts', classification: 'read', wal: false },
      ],
    };
  }
  process.stdout.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
});
