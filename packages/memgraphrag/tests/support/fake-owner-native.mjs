import readline from 'node:readline';

const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  const request = JSON.parse(line);
  const denied = request.method === 'memory_upsert';
  process.stdout.write(`${JSON.stringify({
    id: request.id,
    ok: !denied,
    ...(denied
      ? { error: { code: 'METHOD_DENIED', message: 'owner rejected mutation' } }
      : { result: null }),
  })}\n`);
});
