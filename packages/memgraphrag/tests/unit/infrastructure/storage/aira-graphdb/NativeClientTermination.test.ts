import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import {
  AiraGraphDbNativeClient,
  readAiraGraphDbNativeTerminationReceipt,
  type AiraGraphDbTerminationResult,
} from '../../../../../src/infrastructure/storage/aira-graphdb/NativeClient.js';

class FakeReadable extends EventEmitter {}

class FakeWritable extends EventEmitter {
  public readonly writes: unknown[] = [];
  public endFailure: 'none' | 'throw' | 'callback' = 'none';
  public readonly write = vi.fn((value: unknown, callback?: (error?: Error | null) => void) => {
    this.writes.push(value);
    callback?.();
    return true;
  });
  public readonly end = vi.fn((callback?: (error?: Error | null) => void) => {
    if (this.endFailure === 'throw') throw new Error('/private/stdin-end-secret');
    callback?.(this.endFailure === 'callback'
      ? new Error('/private/stdin-callback-secret')
      : undefined);
    return this;
  });
  public readonly destroy = vi.fn(() => this);
}

class FakeChild extends EventEmitter {
  public readonly stdin = new FakeWritable();
  public readonly stdout = new FakeReadable();
  public readonly stderr = new FakeReadable();
  public readonly kill = vi.fn((_signal: NodeJS.Signals) => true);
}

const originalCommand = process.env.AIRA_GRAPHDB_NATIVE_CMD;

function createClient(observer?: (event: unknown) => void): {
  child: FakeChild;
  client: AiraGraphDbNativeClient;
  receipt: Promise<AiraGraphDbTerminationResult>;
} {
  const child = new FakeChild();
  spawnMock.mockReturnValueOnce(child);
  const client = new AiraGraphDbNativeClient('/private/secret/database.agdb', observer);
  return {
    child,
    client,
    receipt: readAiraGraphDbNativeTerminationReceipt(client),
  };
}

async function settleUnexpected(
  child: FakeChild,
  receipt: Promise<AiraGraphDbTerminationResult>,
): Promise<AiraGraphDbTerminationResult> {
  child.emit('exit', 0, null);
  child.emit('close', 0, null);
  return receipt;
}

beforeEach(() => {
  vi.useFakeTimers();
  spawnMock.mockReset();
  process.env.AIRA_GRAPHDB_NATIVE_CMD = `${process.execPath} /private/secret/fake-native.mjs`;
});

afterEach(() => {
  vi.useRealTimers();
  if (originalCommand === undefined) delete process.env.AIRA_GRAPHDB_NATIVE_CMD;
  else process.env.AIRA_GRAPHDB_NATIVE_CMD = originalCommand;
});

describe.sequential('AiraGraphDbNativeClient direct-child termination', () => {
  it('installs every owning listener while the passive receipt has zero side effects', async () => {
    const { child, client, receipt } = createClient();

    expect(child.listenerCount('spawn')).toBe(1);
    expect(child.listenerCount('error')).toBe(1);
    expect(child.listenerCount('exit')).toBe(1);
    expect(child.listenerCount('close')).toBe(1);
    expect(child.stdin.listenerCount('error')).toBe(1);
    expect(child.stdout.listenerCount('data')).toBe(1);
    expect(child.stdout.listenerCount('end')).toBe(1);
    expect(child.stdout.listenerCount('error')).toBe(1);
    expect(child.stderr.listenerCount('data')).toBe(1);
    expect(child.stderr.listenerCount('error')).toBe(1);
    expect(readAiraGraphDbNativeTerminationReceipt(client)).toBe(receipt);

    let settled = false;
    void receipt.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(child.stdin.end).not.toHaveBeenCalled();
    expect(child.stdin.destroy).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns one Promise<void> and one frozen graceful receipt after exit then close', async () => {
    const { child, client, receipt } = createClient();
    child.emit('spawn');

    const first = client.close();
    const second = client.close();
    expect(first).toBe(second);
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    expect(child.stdin.destroy).not.toHaveBeenCalled();

    child.emit('exit', 0, null);
    child.emit('close', 0, null);

    await expect(first).resolves.toBeUndefined();
    const result = await receipt;
    expect(result).toEqual({ kind: 'graceful_reaped' });
    expect(Reflect.ownKeys(result)).toEqual(['kind']);
    expect(Object.isFrozen(result)).toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['stdin_error', (child: FakeChild) => child.stdin.emit('error', new Error('stdin secret'))],
    ['stdout_error', (child: FakeChild) => child.stdout.emit('error', new Error('stdout secret'))],
    ['stderr_error', (child: FakeChild) => child.stderr.emit('error', new Error('stderr secret'))],
  ] as const)('maps an independent %s to one closed request error and one traffic event', async (
    reason,
    emitError,
  ) => {
    const traffic: unknown[] = [];
    const { child, client, receipt } = createClient((event) => traffic.push(event));
    child.emit('spawn');
    const activeRejected = vi.fn();
    const queuedRejected = vi.fn();
    const active = client.request('first', {}).catch((error: unknown) => {
      activeRejected(error);
      return error;
    });
    const queued = client.request('second', {}).catch((error: unknown) => {
      queuedRejected(error);
      return error;
    });

    emitError(child);

    const [activeError, queuedError] = await Promise.all([active, queued]);
    expect(activeError).toBe(queuedError);
    expect(activeError).toEqual(new Error('aira-graphdb native client closed'));
    expect(activeRejected).toHaveBeenCalledTimes(1);
    expect(queuedRejected).toHaveBeenCalledTimes(1);
    expect(traffic).toEqual([{
      method: 'first',
      requestBytes: Buffer.byteLength(JSON.stringify({ id: 1, method: 'first', params: {} }), 'utf8'),
      outcome: 'transport-error',
      responseBytes: undefined,
    }]);
    expect(child.stdin.destroy).toHaveBeenCalledTimes(1);

    const result = await settleUnexpected(child, receipt);
    expect(result).toEqual({ kind: 'unexpected_reaped', reason, lastSignal: null });
    expect(Reflect.ownKeys(result)).toEqual(['kind', 'reason', 'lastSignal']);
    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it.each(['throw', 'callback'] as const)(
    'records a stdin.end %s without aborting explicit-close completion',
    async (endFailure) => {
      const { child, client, receipt } = createClient();
      child.emit('spawn');
      child.stdin.endFailure = endFailure;

      const close = client.close();
      child.emit('exit', 0, null);
      child.emit('close', 0, null);

      await expect(close).resolves.toBeUndefined();
      await expect(receipt).resolves.toEqual({
        kind: 'unexpected_reaped',
        reason: 'stdin_error',
        lastSignal: null,
      });
    },
  );

  it.each([
    ['stdout_end', (child: FakeChild) => child.stdout.emit('end')],
    ['child_error', (child: FakeChild) => child.emit('error', new Error('/private/child-secret'))],
    ['unexpected_exit', (child: FakeChild) => child.emit('exit', 0, null)],
    ['nonzero_exit', (child: FakeChild) => child.emit('exit', 7, null)],
    ['unknown_exit', (child: FakeChild) => child.emit('exit', null, null)],
    ['signaled_exit', (child: FakeChild) => child.emit('exit', null, 'SIGABRT')],
  ] as const)('classifies %s without retaining raw child data', async (reason, trigger) => {
    const { child, receipt } = createClient();
    child.emit('spawn');
    trigger(child);
    if (reason !== 'unexpected_exit' && reason !== 'nonzero_exit'
      && reason !== 'unknown_exit' && reason !== 'signaled_exit') {
      child.emit('exit', 0, null);
    }
    child.emit('close', 0, null);

    const result = await receipt;
    expect(result).toEqual({ kind: 'unexpected_reaped', reason, lastSignal: null });
    expect(JSON.stringify(result)).not.toContain('/private');
  });

  it('classifies a child error before spawn only after a later qualifying close', async () => {
    const { child, receipt } = createClient();
    child.emit('error', new Error('/private/spawn-secret'));
    child.emit('close', 1, null);

    await expect(receipt).resolves.toEqual({
      kind: 'unexpected_reaped',
      reason: 'spawn_error',
      lastSignal: null,
    });
  });

  it('keeps the first abnormal reason immutable', async () => {
    const { child, receipt } = createClient();
    child.emit('spawn');
    child.stdout.emit('error', new Error('first'));
    child.stderr.emit('error', new Error('second'));
    child.emit('exit', 9, null);
    child.emit('close', 9, null);

    await expect(receipt).resolves.toEqual({
      kind: 'unexpected_reaped',
      reason: 'stdout_error',
      lastSignal: null,
    });
  });

  it('keeps protocol poison authoritative when a stream listener observes the same failure', async () => {
    const traffic: unknown[] = [];
    const { child, client, receipt } = createClient((event) => traffic.push(event));
    child.emit('spawn');
    const active = client.request('first', {});

    child.stdout.emit('data', Buffer.from('{broken\n'));
    child.stdin.emit('error', new Error('/private/duplicate-secret'));

    await expect(active).rejects.toThrow('not valid UTF-8 JSON');
    expect(traffic).toEqual([{
      method: 'first',
      requestBytes: Buffer.byteLength(JSON.stringify({ id: 1, method: 'first', params: {} }), 'utf8'),
      responseBytes: undefined,
      outcome: 'transport-error',
    }]);
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    await expect(receipt).resolves.toEqual({
      kind: 'unexpected_reaped',
      reason: 'protocol_poison',
      lastSignal: null,
    });
  });

  it('uses absolute TERM, KILL, and final deadlines exactly once', async () => {
    const { child, client, receipt } = createClient();
    child.emit('spawn');
    const close = client.close();

    await vi.advanceTimersByTimeAsync(4_999);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(4_999);
    expect(child.kill).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
    await vi.advanceTimersByTimeAsync(4_999);
    let settled = false;
    void receipt.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const result = await receipt;
    expect(result).toEqual({
      kind: 'termination_failed',
      reason: 'sigterm_escalation',
      missing: 'exit',
      lastSignal: 'SIGKILL',
    });
    await expect(close).rejects.toMatchObject({
      name: 'AiraGraphDbTerminationFailedError',
      code: 'AIRA_GRAPHDB_TERMINATION_FAILED',
      message: 'aira-graphdb native termination failed',
      stack: 'AiraGraphDbTerminationFailedError: aira-graphdb native termination failed',
    });
  });

  it('records false and thrown signal attempts without retrying a phase', async () => {
    const { child, client, receipt } = createClient();
    child.emit('spawn');
    child.kill
      .mockReturnValueOnce(false)
      .mockImplementationOnce(() => { throw new Error('signal secret'); });
    void client.close().catch(() => undefined);

    await vi.advanceTimersByTimeAsync(15_000);

    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    await expect(receipt).resolves.toEqual({
      kind: 'termination_failed',
      reason: 'sigterm_escalation',
      missing: 'exit',
      lastSignal: 'SIGKILL',
    });
  });

  it('reconciles overdue TERM and KILL phases when spawn arrives late', async () => {
    const { child, client, receipt } = createClient();
    void client.close().catch(() => undefined);

    await vi.advanceTimersByTimeAsync(6_000);
    expect(child.kill).not.toHaveBeenCalled();
    child.emit('spawn');
    expect(child.kill.mock.calls).toEqual([['SIGTERM']]);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(child.kill).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);

    child.emit('exit', null, 'SIGKILL');
    child.emit('close', null, 'SIGKILL');
    await expect(receipt).resolves.toEqual({
      kind: 'unexpected_reaped',
      reason: 'sigterm_escalation',
      lastSignal: 'SIGKILL',
    });
  });

  it('runs both overdue signal phases exactly once for a spawn after the KILL boundary', async () => {
    const { child, client } = createClient();
    void client.close().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(11_000);

    child.emit('spawn');
    child.emit('spawn');

    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
  });

  it('never signals after either exit or close evidence', async () => {
    const exited = createClient();
    exited.child.emit('spawn');
    void exited.client.close().catch(() => undefined);
    exited.child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(exited.child.kill).not.toHaveBeenCalled();
    await expect(exited.receipt).resolves.toEqual({
      kind: 'termination_failed',
      reason: 'explicit_close',
      missing: 'terminal_close',
      lastSignal: null,
    });

    const closed = createClient();
    closed.child.emit('spawn');
    void closed.client.close().catch(() => undefined);
    closed.child.emit('close', 0, null);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(closed.child.kill).not.toHaveBeenCalled();
    await expect(closed.receipt).resolves.toEqual({
      kind: 'termination_failed',
      reason: 'close_before_exit',
      missing: 'exit',
      lastSignal: null,
    });
  });

  it('requires a second close after exit when close arrived first', async () => {
    const failed = createClient();
    failed.child.emit('spawn');
    failed.child.emit('close', 0, null);
    failed.child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(failed.receipt).resolves.toEqual({
      kind: 'termination_failed',
      reason: 'close_before_exit',
      missing: 'terminal_close',
      lastSignal: null,
    });

    const reaped = createClient();
    reaped.child.emit('spawn');
    reaped.child.emit('close', 0, null);
    reaped.child.emit('exit', 0, null);
    reaped.child.emit('close', 0, null);
    await expect(reaped.receipt).resolves.toEqual({
      kind: 'unexpected_reaped',
      reason: 'close_before_exit',
      lastSignal: null,
    });
  });

  it('closes request admission when an unexpected close starts termination', async () => {
    const { child, client } = createClient();
    child.emit('spawn');
    child.emit('close', 0, null);

    await expect(client.request('after-close', {}))
      .rejects.toThrow('aira-graphdb native client closed');
    expect(child.stdin.write).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'spawn-unconfirmed close',
      trigger: (child: FakeChild) => child.emit('close', 0, null),
      expected: {
        kind: 'termination_failed',
        reason: 'spawn_unconfirmed',
        missing: 'spawn_confirmation',
        lastSignal: null,
      },
    },
    {
      name: 'spawn error without terminal close',
      trigger: (child: FakeChild) => child.emit('error', new Error('spawn failed')),
      expected: {
        kind: 'termination_failed',
        reason: 'spawn_error',
        missing: 'terminal_close',
        lastSignal: null,
      },
    },
  ])('settles a deterministic failure for $name', async ({ trigger, expected }) => {
    const { child, receipt } = createClient();
    trigger(child);
    await vi.advanceTimersByTimeAsync(15_000);

    const result = await receipt;
    expect(result).toEqual(expected);
    expect(Reflect.ownKeys(result)).toEqual(['kind', 'reason', 'missing', 'lastSignal']);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('does not reset absolute deadlines on a delayed repeated close', async () => {
    const { child, client, receipt } = createClient();
    child.emit('spawn');
    const first = client.close();
    await vi.advanceTimersByTimeAsync(10_000);
    const repeated = client.close();
    expect(repeated).toBe(first);

    await vi.advanceTimersByTimeAsync(4_999);
    let settled = false;
    void receipt.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
  });

  it('keeps late operational events as no-ops after settlement', async () => {
    const { child, client, receipt } = createClient();
    child.emit('spawn');
    const close = client.close();
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    const settled = await receipt;

    expect(() => {
      child.stdin.emit('error', new Error('late stdin'));
      child.stdout.emit('error', new Error('late stdout'));
      child.stderr.emit('error', new Error('late stderr'));
      child.emit('error', new Error('late child'));
      child.emit('exit', 9, null);
      child.emit('close', 9, null);
    }).not.toThrow();
    expect(await receipt).toBe(settled);
    await expect(close).resolves.toBeUndefined();
  });

  it('preserves the public Promise<void> close type and exact error own keys', async () => {
    const { child, client } = createClient();
    child.emit('spawn');
    const close: Promise<void> = client.close();
    await vi.advanceTimersByTimeAsync(15_000);

    const error = await close.catch((reason: unknown) => reason);
    expect(Reflect.ownKeys(error).sort()).toEqual(['code', 'message', 'name', 'stack']);
    expect(Object.isFrozen(error)).toBe(true);
    expect('cause' in error).toBe(false);
    expect(JSON.stringify(error)).not.toContain('/private');
  });
});
