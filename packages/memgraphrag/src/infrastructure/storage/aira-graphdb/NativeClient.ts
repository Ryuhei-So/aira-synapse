import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';
import { TextDecoder } from 'node:util';

import { resolveAiraGraphDbRepository } from '../../../../scripts/graphdb-repository-authority.mjs';

interface RpcRequest {
  id: number;
  method: string;
  params?: unknown;
}

interface RpcError {
  code: string;
  message: string;
  failureClass?: string;
}

/** Result from the cypher_query RPC. Discriminated by variant key. */
export type CypherQueryResult =
  | { Nodes: CypherNode[] }
  | { Table: { columns: string[]; rows: CypherValue[][] } }
  | 'Ack';

export interface CypherNode {
  id: string;
  labels: string[];
  properties: Record<string, CypherValue>;
}

export type CypherValue =
  | { String: string }
  | { Int64: number }
  | { Float64: number }
  | { Bool: boolean }
  | null;

interface RpcResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: RpcError;
}

export interface NativeRequestLimits {
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
}

export interface AiraGraphDbTrafficEvent {
  readonly method: string;
  readonly requestBytes: number;
  readonly responseBytes?: number;
  readonly outcome: 'ok' | 'native-error' | 'transport-error';
}

export type AiraGraphDbTrafficObserver = (event: AiraGraphDbTrafficEvent) => void;

export interface AiraGraphDbRpcClient {
  request<T>(method: string, params?: unknown, limits?: NativeRequestLimits): Promise<T>;
}

type TerminationSignal = 'SIGTERM' | 'SIGKILL';

type AbnormalReason =
  | 'protocol_poison'
  | 'stdin_error'
  | 'stdout_end'
  | 'stdout_error'
  | 'stderr_error'
  | 'spawn_error'
  | 'spawn_unconfirmed'
  | 'child_error'
  | 'unexpected_exit'
  | 'unknown_exit'
  | 'nonzero_exit'
  | 'signaled_exit'
  | 'close_before_exit'
  | 'sigterm_escalation'
  | 'sigkill_escalation';

type TerminalEvent =
  | { readonly type: 'spawn' }
  | { readonly type: 'explicit_close' }
  | { readonly type: 'protocol_poison' }
  | { readonly type: 'stdin_error' }
  | { readonly type: 'stdout_end' }
  | { readonly type: 'stdout_error' }
  | { readonly type: 'stderr_error' }
  | { readonly type: 'child_error' }
  | { readonly type: 'exit'; readonly code: number | null; readonly signal: NodeJS.Signals | null }
  | { readonly type: 'close' }
  | { readonly type: 'signal_attempt'; readonly signal: TerminationSignal; readonly sent: boolean };

export type AiraGraphDbTerminationResult =
  | { readonly kind: 'graceful_reaped' }
  | {
      readonly kind: 'unexpected_reaped';
      readonly reason: AbnormalReason;
      readonly lastSignal: TerminationSignal | null;
    }
  | {
      readonly kind: 'termination_failed';
      readonly reason: AbnormalReason | 'explicit_close';
      readonly missing: 'spawn_confirmation' | 'exit' | 'terminal_close';
      readonly lastSignal: TerminationSignal | null;
    };

type FixedTerminationError = Error & { readonly code: string };

interface TerminationHooks {
  readonly closeAdmission: (reason: Error) => void;
  readonly rejectRequests: (reason: Error) => void;
  readonly endStdin: (onError: () => void) => void;
  readonly destroyStdin: (onError: () => void) => void;
}

const TERMINATION_FAILED_NAME = 'AiraGraphDbTerminationFailedError';
const TERMINATION_FAILED_CODE = 'AIRA_GRAPHDB_TERMINATION_FAILED';
const TERMINATION_FAILED_MESSAGE = 'aira-graphdb native termination failed';
const CLOSED_ERROR_MESSAGE = 'aira-graphdb native client closed';
const SIGTERM_AT_MS = 5_000;
const SIGKILL_AT_MS = 10_000;
const FINAL_DEADLINE_MS = 15_000;

function closedClientError(): Error {
  return new Error(CLOSED_ERROR_MESSAGE);
}

function fixedTerminationError(): FixedTerminationError {
  const error = new Error(TERMINATION_FAILED_MESSAGE) as FixedTerminationError;
  Object.defineProperties(error, {
    name: { value: TERMINATION_FAILED_NAME, configurable: true },
    code: { value: TERMINATION_FAILED_CODE, enumerable: true },
    stack: { value: `${TERMINATION_FAILED_NAME}: ${TERMINATION_FAILED_MESSAGE}`, configurable: true },
  });
  return Object.freeze(error);
}

class NativeTerminationController {
  private readonly receiptPromise: Promise<AiraGraphDbTerminationResult>;
  private readonly closePromise: Promise<void>;
  private resolveReceipt!: (result: AiraGraphDbTerminationResult) => void;
  private started = false;
  private settled = false;
  private explicitCloseSeen = false;
  private spawned = false;
  private spawnErrorSequence: number | undefined;
  private exitSequence: number | undefined;
  private closeSequences: number[] = [];
  private exitCode: number | null | undefined;
  private exitSignal: NodeJS.Signals | null | undefined;
  private firstAbnormalReason: AbnormalReason | undefined;
  private lastSignal: TerminationSignal | null = null;
  private startedAt: number | undefined;
  private termAttempted = false;
  private killAttempted = false;
  private sequence = 0;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  public constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly hooks: TerminationHooks,
  ) {
    this.receiptPromise = new Promise((resolveReceipt) => {
      this.resolveReceipt = resolveReceipt;
    });
    this.closePromise = this.receiptPromise.then((result) => {
      if (result.kind === 'termination_failed') throw fixedTerminationError();
    });
    // Abnormal listeners may start termination before any caller invokes close().
    // Retain a passive rejection handler without changing the cached promise.
    void this.closePromise.catch(() => undefined);
  }

  public receipt(): Promise<AiraGraphDbTerminationResult> {
    return this.receiptPromise;
  }

  public close(): Promise<void> {
    this.recordTerminalEvent({ type: 'explicit_close' }, closedClientError());
    return this.closePromise;
  }

  public recordTerminalEvent(event: TerminalEvent, requestError?: Error): void {
    if (this.settled) return;
    this.sequence += 1;
    let startsTermination = false;
    let destroyStdin = true;

    switch (event.type) {
      case 'spawn':
        this.spawned = true;
        this.reconcileSignalPhases();
        break;
      case 'explicit_close':
        this.explicitCloseSeen = true;
        startsTermination = true;
        destroyStdin = false;
        break;
      case 'protocol_poison':
      case 'stdin_error':
      case 'stdout_error':
      case 'stderr_error':
        this.latchAbnormal(event.type);
        startsTermination = true;
        break;
      case 'stdout_end':
        if (!this.explicitCloseSeen) {
          this.latchAbnormal('stdout_end');
          startsTermination = true;
        }
        break;
      case 'child_error':
        if (this.spawned) {
          this.latchAbnormal('child_error');
        } else {
          this.spawnErrorSequence ??= this.sequence;
          this.latchAbnormal('spawn_error');
        }
        startsTermination = true;
        break;
      case 'exit':
        this.exitSequence ??= this.sequence;
        this.exitCode = event.code;
        this.exitSignal = event.signal;
        if (event.signal !== null) {
          this.latchAbnormal('signaled_exit');
        } else if (event.code === null) {
          this.latchAbnormal('unknown_exit');
        } else if (event.code !== 0) {
          this.latchAbnormal('nonzero_exit');
        } else if (!this.explicitCloseSeen) {
          this.latchAbnormal('unexpected_exit');
        }
        startsTermination = !this.started;
        break;
      case 'close':
        this.closeSequences.push(this.sequence);
        if (this.spawned && this.exitSequence === undefined) {
          this.latchAbnormal('close_before_exit');
        } else if (!this.spawned && this.spawnErrorSequence === undefined) {
          this.latchAbnormal('spawn_unconfirmed');
        }
        startsTermination = !this.started;
        break;
      case 'signal_attempt':
        this.lastSignal = event.signal;
        this.latchAbnormal(event.signal === 'SIGTERM'
          ? 'sigterm_escalation'
          : 'sigkill_escalation');
        break;
    }

    if (startsTermination && !this.started) {
      this.start(requestError ?? closedClientError(), destroyStdin);
    }
    this.maybeSettleReaped();
  }

  private latchAbnormal(reason: AbnormalReason): void {
    this.firstAbnormalReason ??= reason;
  }

  private start(requestError: Error, destroyStdin: boolean): void {
    if (this.started || this.settled) return;
    this.started = true;
    this.startedAt = globalThis.performance.now();
    this.hooks.closeAdmission(requestError);
    this.hooks.rejectRequests(requestError);
    if (destroyStdin) {
      this.hooks.destroyStdin(() => {
        this.recordTerminalEvent({ type: 'stdin_error' });
      });
    } else {
      this.hooks.endStdin(() => {
        this.recordTerminalEvent({ type: 'stdin_error' });
      });
    }
    if (this.settled) return;
    this.scheduleAt(this.startedAt, SIGTERM_AT_MS, () => this.reconcileSignalPhases());
    this.scheduleAt(this.startedAt, SIGKILL_AT_MS, () => this.reconcileSignalPhases());
    this.scheduleAt(this.startedAt, FINAL_DEADLINE_MS, () => this.settleFailed());
  }

  private scheduleAt(startedAt: number, offsetMs: number, callback: () => void): void {
    // Never fire before the absolute boundary when the monotonic clock has a
    // fractional-millisecond value but the timer implementation rounds delay.
    const delay = Math.max(0, Math.ceil(startedAt + offsetMs - globalThis.performance.now()));
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.settled) callback();
    }, delay);
    this.timers.add(timer);
  }

  private reconcileSignalPhases(): void {
    if (this.settled || !this.spawned || this.startedAt === undefined
      || this.exitSequence !== undefined || this.closeSequences.length > 0) return;
    const elapsed = globalThis.performance.now() - this.startedAt;
    if (elapsed >= SIGTERM_AT_MS) this.attemptSignal('SIGTERM');
    if (elapsed >= SIGKILL_AT_MS) this.attemptSignal('SIGKILL');
  }

  private attemptSignal(signal: TerminationSignal): void {
    if (this.settled || this.exitSequence !== undefined || this.closeSequences.length > 0) return;
    if (signal === 'SIGTERM') {
      if (this.termAttempted) return;
      this.termAttempted = true;
    } else {
      if (this.killAttempted) return;
      this.killAttempted = true;
    }
    let sent = false;
    try {
      sent = this.child.kill(signal);
    } catch {
      sent = false;
    }
    this.recordTerminalEvent({ type: 'signal_attempt', signal, sent });
  }

  private qualifyingCloseAfter(sequence: number | undefined): boolean {
    return sequence !== undefined && this.closeSequences.some((closeSequence) => closeSequence > sequence);
  }

  private maybeSettleReaped(): void {
    if (!this.started || this.settled) return;
    const spawnedReaped = this.spawned && this.qualifyingCloseAfter(this.exitSequence);
    const spawnFailureReaped = !this.spawned && this.qualifyingCloseAfter(this.spawnErrorSequence);
    if (!spawnedReaped && !spawnFailureReaped) return;

    const graceful = spawnedReaped
      && this.explicitCloseSeen
      && this.firstAbnormalReason === undefined
      && this.lastSignal === null
      && this.exitCode === 0
      && this.exitSignal === null;
    if (graceful) {
      this.settle(Object.freeze({ kind: 'graceful_reaped' }));
      return;
    }

    const reason = this.firstAbnormalReason;
    if (reason === undefined) return;
    this.settle(Object.freeze({
      kind: 'unexpected_reaped',
      reason,
      lastSignal: this.lastSignal,
    }));
  }

  private settleFailed(): void {
    if (this.settled) return;
    const missing = !this.spawned && this.spawnErrorSequence === undefined
      ? 'spawn_confirmation'
      : this.spawned && this.exitSequence === undefined
        ? 'exit'
        : 'terminal_close';
    this.settle(Object.freeze({
      kind: 'termination_failed',
      reason: this.firstAbnormalReason ?? 'explicit_close',
      missing,
      lastSignal: this.lastSignal,
    }));
  }

  private settle(result: AiraGraphDbTerminationResult): void {
    if (this.settled) return;
    this.settled = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.resolveReceipt(result);
  }
}

interface QueuedRequest {
  readonly id: number;
  readonly method: string;
  readonly encoded: Buffer;
  readonly requestBytes: number;
  readonly maxResponseBytes: number;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason?: unknown) => void;
}

const MAX_COMPATIBILITY_FRAME_BYTES = 512 * 1024 * 1024;
const MAX_QUEUED_REQUESTS = 4096;
const DEFAULT_LIMITS: NativeRequestLimits = {
  maxRequestBytes: MAX_COMPATIBILITY_FRAME_BYTES,
  maxResponseBytes: MAX_COMPATIBILITY_FRAME_BYTES,
};
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length
    && expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function positiveSafeLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  if (value > MAX_COMPATIBILITY_FRAME_BYTES) {
    throw new Error(`${name} must not exceed ${MAX_COMPATIBILITY_FRAME_BYTES}`);
  }
}

function defaultCommand(dbPath: string): { command: string; args: string[] } {
  const { repositoryPath: repoPath } = resolveAiraGraphDbRepository();
  return {
    command: 'cargo',
    args: [
      'run',
      '--quiet',
      '--manifest-path',
      resolve(repoPath, 'Cargo.toml'),
      '--bin',
      'aira-graphdb-native',
      '--',
      '--db',
      dbPath,
    ],
  };
}

function parseCommand(raw: string): { command: string; args: string[] } {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    throw new Error('AIRA_GRAPHDB_NATIVE_CMD is empty');
  }
  return {
    command: parts[0]!,
    args: parts.slice(1),
  };
}

export class AiraGraphDbNativeClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private stderrTail = '';
  private readonly queue: QueuedRequest[] = [];
  private active: QueuedRequest | undefined;
  private frameChunks: Buffer[] = [];
  private frameBytes = 0;
  private poisonError: Error | undefined;
  private closing = false;
  private nextId = 1;

  public constructor(
    dbPath: string,
    private readonly trafficObserver?: AiraGraphDbTrafficObserver,
  ) {
    const cmd = process.env.AIRA_GRAPHDB_NATIVE_CMD
      ? parseCommand(process.env.AIRA_GRAPHDB_NATIVE_CMD)
      : defaultCommand(dbPath);
    const command = cmd.command;
    const args = process.env.AIRA_GRAPHDB_NATIVE_CMD
      ? [...cmd.args, '--db', dbPath]
      : cmd.args;
    this.child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: process.cwd(),
    });

    const termination = new NativeTerminationController(this.child, {
      closeAdmission: (reason) => {
        if (!this.closing && !this.poisonError) this.poisonError = reason;
      },
      rejectRequests: (reason) => this.rejectQueued(reason),
      endStdin: (onError) => {
        try {
          this.child.stdin.end((error?: Error | null) => {
            if (error) onError();
          });
        } catch {
          onError();
        }
      },
      destroyStdin: (onError) => {
        try {
          this.child.stdin.destroy();
        } catch {
          onError();
        }
      },
    });
    NATIVE_TERMINATIONS.set(this, termination);

    this.child.on('spawn', () => termination.recordTerminalEvent({ type: 'spawn' }));
    this.child.stdin.on('error', () => this.poison(closedClientError(), 'stdin_error'));
    this.child.stdout.on('error', () => this.poison(closedClientError(), 'stdout_error'));
    this.child.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    this.child.stdout.on('end', () => {
      const suffix = this.frameBytes > 0 ? ' with a partial response frame' : '';
      const error = new Error(`aira-graphdb stdout ended unexpectedly${suffix}`);
      if (this.closing) {
        termination.recordTerminalEvent({ type: 'stdout_end' });
      } else {
        this.poison(error, 'stdout_end');
      }
    });
    this.child.stderr.on('error', () => this.poison(closedClientError(), 'stderr_error'));
    this.child.on('error', (error) => this.poison(error, 'child_error'));
    this.child.on('exit', (code, signal) => {
      const details = this.stderrTail.length > 0
        ? `; stderr=${this.stderrTail}`
        : '';
      const error = new Error(`aira-graphdb-native exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})${details}`);
      termination.recordTerminalEvent({ type: 'exit', code, signal }, error);
    });
    this.child.on('close', () => {
      termination.recordTerminalEvent({ type: 'close' }, closedClientError());
    });
    this.child.stderr.on('data', (chunk) => {
      // Keep stderr consumed to avoid backpressure deadlocks.
      this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-4000);
    });
  }

  public async request<T>(
    method: string,
    params?: unknown,
    limits: NativeRequestLimits = DEFAULT_LIMITS,
  ): Promise<T> {
    if (this.closing) {
      throw new Error('aira-graphdb native client is closed');
    }
    if (this.poisonError) {
      throw this.poisonError;
    }
    if (this.queue.length + (this.active ? 1 : 0) >= MAX_QUEUED_REQUESTS) {
      throw new Error(`aira-graphdb request queue exceeds ${MAX_QUEUED_REQUESTS} items`);
    }
    positiveSafeLimit(limits.maxRequestBytes, 'maxRequestBytes');
    positiveSafeLimit(limits.maxResponseBytes, 'maxResponseBytes');
    if (!Number.isSafeInteger(this.nextId)) {
      throw new Error('aira-graphdb request ID space exhausted');
    }
    const id = this.nextId;
    this.nextId += 1;
    const payload: RpcRequest = { id, method, params };
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8');
    if (encoded.byteLength > limits.maxRequestBytes) {
      throw new Error(`aira-graphdb request exceeds ${limits.maxRequestBytes} bytes`);
    }

    return new Promise<T>((resolveRequest, rejectRequest) => {
      this.queue.push({
        id,
        method,
        encoded,
        requestBytes: encoded.byteLength,
        maxResponseBytes: limits.maxResponseBytes,
        resolve: resolveRequest as (value: unknown) => void,
        reject: rejectRequest,
      });
      this.pump();
    });
  }

  public close(): Promise<void> {
    this.closing = true;
    return nativeTerminationController(this).close();
  }

  /**
   * Execute a Cypher query against the graph store.
   * @param query - Cypher query string
   * @param corpusId - optional corpus filter
   * @param dialect - 'openCypher9' (default) or 'neo4jCompat'
   */
  public async cypherQuery(
    query: string,
    corpusId?: string,
    dialect: 'openCypher9' | 'neo4jCompat' = 'openCypher9',
  ): Promise<CypherQueryResult> {
    return this.request<CypherQueryResult>('cypher_query', {
      query,
      ...(corpusId != null && { corpusId }),
      dialect,
    });
  }

  private pump(): void {
    if (this.active || this.closing || this.poisonError) return;
    const next = this.queue.shift();
    if (!next) return;
    this.active = next;
    this.child.stdin.write(next.encoded, (writeError) => {
      if (writeError) this.poison(writeError, 'protocol_poison');
    });
    this.child.stdin.write('\n', (writeError) => {
      if (writeError) this.poison(writeError, 'protocol_poison');
    });
  }

  private onData(chunk: Buffer): void {
    if (this.closing || this.poisonError) return;
    const active = this.active;
    if (!active) {
      this.poison(new Error('aira-graphdb emitted a response without an active request'), 'protocol_poison');
      return;
    }

    const newline = chunk.indexOf(0x0a);
    const frameChunk = newline === -1 ? chunk : chunk.subarray(0, newline);
    if (frameChunk.byteLength > 0) {
      this.frameChunks.push(frameChunk);
      this.frameBytes += frameChunk.byteLength;
    }
    if (this.frameBytes > active.maxResponseBytes) {
      this.poison(new Error(`aira-graphdb response exceeds ${active.maxResponseBytes} bytes`), 'protocol_poison');
      return;
    }
    if (newline === -1) return;
    if (newline !== chunk.byteLength - 1) {
      this.poison(new Error('aira-graphdb emitted bytes after a complete response frame'), 'protocol_poison');
      return;
    }

    let frame = Buffer.concat(this.frameChunks, this.frameBytes);
    const responseBytes = this.frameBytes;
    this.frameChunks = [];
    this.frameBytes = 0;
    if (frame.at(-1) === 0x0d) frame = frame.subarray(0, -1);
    this.finishFrame(frame, responseBytes);
  }

  private finishFrame(frame: Buffer, responseBytes: number): void {
    const active = this.active;
    if (!active) {
      this.poison(new Error('aira-graphdb response has no active request'), 'protocol_poison');
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(UTF8_DECODER.decode(frame)) as unknown;
    } catch (error) {
      this.poison(new Error(`aira-graphdb response is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`), 'protocol_poison');
      return;
    }

    if (!isObject(parsed)
      || !Number.isSafeInteger(parsed.id)
      || typeof parsed.ok !== 'boolean'
      || parsed.id !== active.id) {
      this.poison(new Error('aira-graphdb response envelope or request ID is invalid'), 'protocol_poison');
      return;
    }
    const response = parsed as unknown as RpcResponse;
    const expectedKeys = response.ok
      ? ['id', 'ok', 'result'] as const
      : ['id', 'ok', 'error'] as const;
    if (!hasExactKeys(parsed, expectedKeys)) {
      this.poison(new Error('aira-graphdb response envelope variant is invalid'), 'protocol_poison');
      return;
    }
    this.active = undefined;
    if (!response.ok) {
      const hasFailureClass = isObject(response.error)
        && Object.prototype.hasOwnProperty.call(response.error, 'failureClass');
      const errorKeys = hasFailureClass
        ? ['code', 'message', 'failureClass'] as const
        : ['code', 'message'] as const;
      if (!isObject(response.error)
        || !hasExactKeys(response.error, errorKeys)
        || typeof response.error.code !== 'string'
        || typeof response.error.message !== 'string'
        || (hasFailureClass && typeof response.error.failureClass !== 'string')) {
        this.active = active;
        this.poison(new Error('aira-graphdb error response is malformed'), 'protocol_poison');
        return;
      }
      const code = response.error.code;
      const message = response.error.message;
      const error = new Error(message) as Error & { code?: string; failureClass?: string };
      error.code = code;
      if (response.error.failureClass !== undefined) {
        error.failureClass = response.error.failureClass;
      }
      this.emitTraffic(active, 'native-error', responseBytes);
      active.reject(error);
      this.pump();
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(response, 'result')) {
      this.active = active;
      this.poison(new Error('aira-graphdb success response has no result'), 'protocol_poison');
      return;
    }
    this.emitTraffic(active, 'ok', responseBytes);
    active.resolve(response.result);
    this.pump();
  }

  private emitTraffic(
    request: QueuedRequest,
    outcome: AiraGraphDbTrafficEvent['outcome'],
    responseBytes?: number,
  ): void {
    if (!this.trafficObserver) return;
    try {
      this.trafficObserver({
        method: request.method,
        requestBytes: request.requestBytes,
        responseBytes,
        outcome,
      });
    } catch {
      // Measurement must not become persistence authority.
    }
  }

  private rejectQueued(reason: Error): void {
    if (this.active) {
      this.emitTraffic(this.active, 'transport-error');
      this.active.reject(reason);
      this.active = undefined;
    }
    for (const request of this.queue.splice(0)) {
      request.reject(reason);
    }
    this.frameChunks = [];
    this.frameBytes = 0;
  }

  private poison(reason: unknown, type: Extract<TerminalEvent, {
    readonly type: 'protocol_poison' | 'stdin_error' | 'stdout_end' | 'stdout_error' | 'stderr_error' | 'child_error';
  }>['type']): void {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    if (!this.poisonError && !this.closing) this.poisonError = error;
    nativeTerminationController(this).recordTerminalEvent({ type }, error);
  }
}

const NATIVE_TERMINATIONS = new WeakMap<AiraGraphDbNativeClient, NativeTerminationController>();

function nativeTerminationController(client: AiraGraphDbNativeClient): NativeTerminationController {
  const controller = NATIVE_TERMINATIONS.get(client);
  if (!controller) throw new TypeError('unknown aira-graphdb native client');
  return controller;
}

/** Package-internal passive lifecycle receipt. Not re-exported from a public barrel. */
export function readAiraGraphDbNativeTerminationReceipt(
  client: AiraGraphDbNativeClient,
): Promise<AiraGraphDbTerminationResult> {
  return nativeTerminationController(client).receipt();
}
