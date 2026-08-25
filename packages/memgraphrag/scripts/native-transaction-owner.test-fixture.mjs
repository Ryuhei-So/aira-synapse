#!/usr/bin/env node

/**
 * Test-only transaction owner for the exact aira-graphdb native binary.
 *
 * Production never uses this file: Literature Hub owns prepare/evidence and
 * presents the same batch_commit surface to Synapse through its native proxy.
 * CI launches the native binary directly, so this fixture supplies only that
 * missing owner transition without adding prepare authority to production
 * Synapse code.
 */
import { spawn } from 'node:child_process';

const MAX_FRAME_BYTES = 512 * 1024 * 1024;
const args = process.argv.slice(2);
const nativeCommand = args.shift();

if (!nativeCommand || args.length !== 2 || args[0] !== '--db' || !args[1]) {
  process.stderr.write('usage: native-transaction-owner.test-fixture.mjs <native-command> --db <path>\n');
  process.exit(2);
}

const native = spawn(nativeCommand, args, { stdio: ['pipe', 'pipe', 'pipe'] });
native.stderr.pipe(process.stderr);

let clientBuffer = Buffer.alloc(0);
let nativeBuffer = Buffer.alloc(0);
let active;
const queued = [];
let internalSequence = 0;
let closing = false;

function fail(message) {
  if (closing) return;
  closing = true;
  process.stderr.write(`${message}\n`);
  process.stdin.destroy();
  native.stdin.destroy();
  process.stdout.end();
  native.kill('SIGTERM');
  process.exitCode = 1;
}

function appendFrame(buffer, chunk, source) {
  const nextBytes = buffer.byteLength + chunk.byteLength;
  if (nextBytes > MAX_FRAME_BYTES) {
    fail(`${source} frame exceeds ${MAX_FRAME_BYTES} bytes`);
    return buffer;
  }
  return Buffer.concat([buffer, chunk], nextBytes);
}

function writeNative(value) {
  const encoded = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  if (encoded.byteLength > MAX_FRAME_BYTES) {
    fail(`native request exceeds ${MAX_FRAME_BYTES} bytes`);
    return;
  }
  native.stdin.write(encoded);
}

function sendClient(value) {
  const encoded = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  if (encoded.byteLength > MAX_FRAME_BYTES) {
    fail(`client response exceeds ${MAX_FRAME_BYTES} bytes`);
    return;
  }
  process.stdout.write(encoded);
}

function runNext() {
  if (active || queued.length === 0 || closing) return;
  const request = queued.shift();
  if (!request || typeof request !== 'object' || request.id === undefined
      || typeof request.method !== 'string') {
    fail('client sent an invalid RPC request');
    return;
  }
  if (request.method === 'batch_prepare_commit') {
    sendClient({
      id: request.id,
      ok: false,
      error: {
        code: 'METHOD_DENIED',
        message: 'batch_prepare_commit is owned by the transaction supervisor',
      },
    });
    queueMicrotask(runNext);
    return;
  }
  if (request.method === 'batch_commit') {
    internalSequence += 1;
    const nativeId = Number.MAX_SAFE_INTEGER - (internalSequence * 2);
    active = {
      kind: 'prepare',
      outerId: request.id,
      sequence: internalSequence,
      nativeId,
    };
    writeNative({
      id: nativeId,
      method: 'batch_prepare_commit',
      params: {},
    });
    return;
  }
  active = { kind: 'forward', outerId: request.id, nativeId: request.id };
  writeNative(request);
}

function handleNativeResponse(response) {
  if (!active || !response || typeof response !== 'object' || typeof response.ok !== 'boolean') {
    fail('native sent an unexpected RPC response');
    return;
  }
  if (!Number.isSafeInteger(response.id) || response.id !== active.nativeId) {
    fail('native response ID does not match the active request');
    return;
  }
  if (active.kind === 'forward') {
    sendClient({ ...response, id: active.outerId });
    active = undefined;
    runNext();
    return;
  }
  if (active.kind === 'prepare') {
    if (!response.ok) {
      sendClient({ ...response, id: active.outerId });
      active = undefined;
      runNext();
      return;
    }
    const pending = active;
    const nativeId = Number.MAX_SAFE_INTEGER - (pending.sequence * 2) + 1;
    active = {
      kind: 'commit',
      outerId: pending.outerId,
      sequence: pending.sequence,
      nativeId,
    };
    writeNative({
      id: nativeId,
      method: 'batch_commit',
      params: { preparedCommitEvidence: response.result },
    });
    return;
  }
  sendClient({ ...response, id: active.outerId });
  active = undefined;
  runNext();
}

function consumeLines(buffer, onLine) {
  let remaining = buffer;
  for (;;) {
    const newline = remaining.indexOf(0x0a);
    if (newline < 0) return remaining;
    const frame = remaining.subarray(0, newline);
    remaining = remaining.subarray(newline + 1);
    if (frame.byteLength === 0) {
      fail('empty JSONL frame');
      return Buffer.alloc(0);
    }
    try {
      onLine(JSON.parse(frame.toString('utf8')));
    } catch {
      fail('invalid JSONL frame');
      return Buffer.alloc(0);
    }
  }
}

process.stdin.on('data', (chunk) => {
  clientBuffer = appendFrame(clientBuffer, chunk, 'client');
  clientBuffer = consumeLines(clientBuffer, (request) => queued.push(request));
  runNext();
});
process.stdin.on('end', () => {
  if (clientBuffer.byteLength !== 0) {
    fail('client ended with a partial frame');
    return;
  }
  native.stdin.end();
});

native.stdout.on('data', (chunk) => {
  nativeBuffer = appendFrame(nativeBuffer, chunk, 'native');
  nativeBuffer = consumeLines(nativeBuffer, handleNativeResponse);
});
native.on('error', (error) => fail(`native spawn failed: ${error.message}`));
native.on('exit', (code, signal) => {
  if (nativeBuffer.byteLength !== 0) {
    fail('native ended with a partial frame');
    return;
  }
  if (active || queued.length > 0) {
    fail('native exited with RPC work pending');
    return;
  }
  closing = true;
  process.exitCode = code === 0 && signal === null ? 0 : 1;
});
