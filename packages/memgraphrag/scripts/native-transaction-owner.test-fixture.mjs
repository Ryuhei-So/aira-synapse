#!/usr/bin/env node

/**
 * Test-only transaction owner for the exact aira-graphdb native binary.
 *
 * Production never uses this file: Literature Hub owns prepare/evidence and
 * presents the same batch_commit surface to Synapse through its native proxy.
 * CI launches the native binary directly, so this fixture supplies only that
 * missing owner transition without adding prepare authority to production
 * Synapse code.
 *
 * Like the Literature Hub owner (scripts/graphdb/owner.mjs), batch_begin is
 * virtual until the first mutation: the native transaction opens just before
 * the first request the native classifies as a mutation, and a batch_commit
 * with no mutation is a no-op that leaves the generation unchanged
 * (literature-hub #614: a job whose documents were all refused).
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
/** Method name -> classification, from the native's protocol_info. */
let methodPolicy;
let policyRequested = false;
let virtualBatchOpen = false;
let nativeBatchOpen = false;

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

function nextInternalId() {
  internalSequence += 1;
  return Number.MAX_SAFE_INTEGER - (internalSequence * 2);
}

function runNext() {
  if (active || closing) return;
  if (!methodPolicy) {
    if (policyRequested || queued.length === 0) return;
    policyRequested = true;
    active = { kind: 'policy', nativeId: nextInternalId() };
    writeNative({ id: active.nativeId, method: 'protocol_info', params: {} });
    return;
  }
  if (queued.length === 0) return;
  const request = queued[0];
  if (!request || typeof request !== 'object' || request.id === undefined
      || typeof request.method !== 'string') {
    fail('client sent an invalid RPC request');
    return;
  }
  if (request.method === 'batch_prepare_commit') {
    queued.shift();
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
  if (request.method === 'batch_begin' && !nativeBatchOpen) {
    queued.shift();
    if (virtualBatchOpen) {
      sendClient({ id: request.id, ok: false, error: { code: 'GENERATION_DIRTY', message: 'batch already open' } });
    } else {
      virtualBatchOpen = true;
      sendClient({ id: request.id, ok: true, result: null });
    }
    queueMicrotask(runNext);
    return;
  }
  if (virtualBatchOpen && !nativeBatchOpen
      && methodPolicy.get(request.method) === 'mutation') {
    // Open the native transaction just before the first mutation.
    active = { kind: 'begin', nativeId: nextInternalId() };
    writeNative({ id: active.nativeId, method: 'batch_begin', params: {} });
    return;
  }
  queued.shift();
  if (request.method === 'batch_commit') {
    if (virtualBatchOpen && !nativeBatchOpen) {
      virtualBatchOpen = false;
      sendClient({ id: request.id, ok: true, result: null });
      queueMicrotask(runNext);
      return;
    }
    const nativeId = nextInternalId();
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
  if (request.method === 'batch_begin') nativeBatchOpen = true;
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
  if (active.kind === 'policy') {
    if (!response.ok || !Array.isArray(response.result?.methods)) {
      fail('native protocol_info did not return a method policy');
      return;
    }
    methodPolicy = new Map(response.result.methods.map((method) => [method.name, method.classification]));
    active = undefined;
    runNext();
    return;
  }
  if (active.kind === 'begin') {
    if (!response.ok) {
      fail('native batch_begin failed');
      return;
    }
    nativeBatchOpen = true;
    active = undefined;
    runNext();
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
  if (response.ok) {
    nativeBatchOpen = false;
    virtualBatchOpen = false;
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
