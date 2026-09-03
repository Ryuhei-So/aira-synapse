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
  }
  process.stdout.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
});
