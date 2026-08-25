import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { AiraGraphDbNativeClient } from '../../../../../src/infrastructure/storage/aira-graphdb/NativeClient.js';

const temporaryDirectories: string[] = [];
const originalCommand = process.env.AIRA_GRAPHDB_NATIVE_CMD;

function fakeNative(mode:
  | 'valid'
  | 'oversized'
  | 'unknown-id'
  | 'invalid-json'
  | 'clean-eof'
  | 'partial-eof'
  | 'success-extra'
  | 'success-error'
  | 'error-result'
  | 'error-extra'
): string {
  const directory = mkdtempSync(join(tmpdir(), 'aira-native-frame-'));
  temporaryDirectories.push(directory);
  const script = join(directory, 'fake-native.mjs');
  writeFileSync(script, `
const mode = process.argv[2];
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  for (;;) {
    const newline = input.indexOf('\\n');
    if (newline < 0) return;
    const request = JSON.parse(input.slice(0, newline));
    input = input.slice(newline + 1);
    if (mode === 'valid') process.stdout.write(JSON.stringify({ id: request.id, ok: true, result: { pong: true } }) + '\\n');
    if (mode === 'oversized') process.stdout.write('x'.repeat(65) + '\\n');
    if (mode === 'unknown-id') process.stdout.write(JSON.stringify({ id: request.id + 1, ok: true, result: null }) + '\\n');
    if (mode === 'invalid-json') process.stdout.write('{broken\\n');
    if (mode === 'clean-eof') process.stdout.end();
    if (mode === 'partial-eof') { process.stdout.write('{'); process.stdout.end(); }
    if (mode === 'success-extra') process.stdout.write(JSON.stringify({ id: request.id, ok: true, result: null, extra: true }) + '\\n');
    if (mode === 'success-error') process.stdout.write(JSON.stringify({ id: request.id, ok: true, result: null, error: { code: 'X', message: 'contradiction' } }) + '\\n');
    if (mode === 'error-result') process.stdout.write(JSON.stringify({ id: request.id, ok: false, error: { code: 'X', message: 'failed' }, result: null }) + '\\n');
    if (mode === 'error-extra') process.stdout.write(JSON.stringify({ id: request.id, ok: false, error: { code: 'X', message: 'failed', extra: true } }) + '\\n');
  }
});
`);
  process.env.AIRA_GRAPHDB_NATIVE_CMD = `${process.execPath} ${script} ${mode}`;
  return join(directory, 'db.json');
}

function wrongIdOwnerFixture(): string {
  const directory = mkdtempSync(join(tmpdir(), 'aira-owner-id-'));
  temporaryDirectories.push(directory);
  const native = join(directory, 'wrong-id-native.mjs');
  writeFileSync(native, `#!/usr/bin/env node
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  const newline = input.indexOf('\\n');
  if (newline < 0) return;
  const request = JSON.parse(input.slice(0, newline));
  process.stdout.write(JSON.stringify({ id: request.id + 1, ok: true, result: null }) + '\\n');
});
`);
  chmodSync(native, 0o755);
  const ownerFixture = join(process.cwd(), 'scripts', 'native-transaction-owner.test-fixture.mjs');
  process.env.AIRA_GRAPHDB_NATIVE_CMD = `${process.execPath} ${ownerFixture} ${native}`;
  return join(directory, 'db.json');
}

afterEach(() => {
  if (originalCommand === undefined) delete process.env.AIRA_GRAPHDB_NATIVE_CMD;
  else process.env.AIRA_GRAPHDB_NATIVE_CMD = originalCommand;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe.sequential('AiraGraphDbNativeClient physical frame bounds', () => {
  it('records payload-free byte pressure for a valid ordered response', async () => {
    const events: unknown[] = [];
    const client = new AiraGraphDbNativeClient(fakeNative('valid'), (event) => events.push(event));
    await expect(client.request('ping', {}, { maxRequestBytes: 1024, maxResponseBytes: 1024 }))
      .resolves.toEqual({ pong: true });
    expect(events).toEqual([expect.objectContaining({
      method: 'ping',
      outcome: 'ok',
      requestBytes: expect.any(Number),
      responseBytes: expect.any(Number),
    })]);
    expect(JSON.stringify(events)).not.toContain('pong');
    await client.close();
  });

  it('rejects an oversized request before writing it', async () => {
    const client = new AiraGraphDbNativeClient(fakeNative('valid'));
    await expect(client.request('ping', { value: 'large' }, { maxRequestBytes: 8, maxResponseBytes: 1024 }))
      .rejects.toThrow('request exceeds 8 bytes');
    await expect(client.request('ping', {}, {
      maxRequestBytes: 1024,
      maxResponseBytes: 512 * 1024 * 1024 + 1,
    })).rejects.toThrow('must not exceed');
    await client.close();
  });

  it('accepts exact request/response byte caps and rejects one byte less', async () => {
    const requestBytes = Buffer.byteLength(JSON.stringify({ id: 1, method: 'ping', params: {} }), 'utf8');
    const responseBytes = Buffer.byteLength(JSON.stringify({ id: 1, ok: true, result: { pong: true } }), 'utf8');
    const exact = new AiraGraphDbNativeClient(fakeNative('valid'));
    await expect(exact.request('ping', {}, {
      maxRequestBytes: requestBytes,
      maxResponseBytes: responseBytes,
    })).resolves.toEqual({ pong: true });
    await exact.close();

    const requestOver = new AiraGraphDbNativeClient(fakeNative('valid'));
    await expect(requestOver.request('ping', {}, {
      maxRequestBytes: requestBytes - 1,
      maxResponseBytes: responseBytes,
    })).rejects.toThrow('request exceeds');
    await requestOver.close();

    const responseOver = new AiraGraphDbNativeClient(fakeNative('valid'));
    await expect(responseOver.request('ping', {}, {
      maxRequestBytes: requestBytes,
      maxResponseBytes: responseBytes - 1,
    })).rejects.toThrow('response exceeds');
    await responseOver.close();
  });

  it.each([
    ['oversized', 'response exceeds 64 bytes', 64],
    ['unknown-id', 'request ID is invalid', 1024],
    ['invalid-json', 'not valid UTF-8 JSON', 1024],
    ['clean-eof', 'stdout ended unexpectedly', 1024],
    ['partial-eof', 'partial response frame', 1024],
    ['success-extra', 'envelope variant is invalid', 1024],
    ['success-error', 'envelope variant is invalid', 1024],
    ['error-result', 'envelope variant is invalid', 1024],
    ['error-extra', 'error response is malformed', 1024],
  ] as const)('poisons the transport for a %s response', async (mode, message, maxResponseBytes) => {
    const events: unknown[] = [];
    const client = new AiraGraphDbNativeClient(fakeNative(mode), (event) => events.push(event));
    await expect(client.request('ping', {}, { maxRequestBytes: 1024, maxResponseBytes }))
      .rejects.toThrow(message);
    await expect(client.request('ping', {}, { maxRequestBytes: 1024, maxResponseBytes }))
      .rejects.toThrow();
    expect(events).toEqual([expect.objectContaining({ method: 'ping', outcome: 'transport-error' })]);
    await client.close();
  });

  it('fails closed when the test owner sees a mismatched native response ID', async () => {
    const client = new AiraGraphDbNativeClient(wrongIdOwnerFixture());
    await expect(client.request('ping', {}, { maxRequestBytes: 1024, maxResponseBytes: 1024 }))
      .rejects.toThrow();
    await expect(client.request('ping', {}, { maxRequestBytes: 1024, maxResponseBytes: 1024 }))
      .rejects.toThrow();
    await client.close();
  });

  it('serializes concurrent requests so each response uses its own cap', async () => {
    const client = new AiraGraphDbNativeClient(fakeNative('valid'));
    const first = client.request('ping', { order: 1 }, { maxRequestBytes: 1024, maxResponseBytes: 1024 });
    const second = client.request('ping', { order: 2 }, { maxRequestBytes: 1024, maxResponseBytes: 1024 });
    await expect(Promise.all([first, second])).resolves.toEqual([{ pong: true }, { pong: true }]);
    await client.close();
  });
});
