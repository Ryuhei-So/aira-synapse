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

    this.child.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    this.child.stdout.on('end', () => {
      if (this.closing) return;
      const suffix = this.frameBytes > 0 ? ' with a partial response frame' : '';
      this.poison(new Error(`aira-graphdb stdout ended unexpectedly${suffix}`));
    });
    this.child.on('error', (error) => this.poison(error));
    this.child.on('exit', (code, signal) => {
      if (this.closing) return;
      const details = this.stderrTail.length > 0
        ? `; stderr=${this.stderrTail}`
        : '';
      this.poison(new Error(`aira-graphdb-native exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})${details}`));
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

  public async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const closed = new Error('aira-graphdb native client closed');
    this.rejectQueued(closed);
    this.child.stdin.end();
    if (!this.child.killed) {
      this.child.kill('SIGTERM');
    }
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
      if (writeError) this.poison(writeError);
    });
    this.child.stdin.write('\n', (writeError) => {
      if (writeError) this.poison(writeError);
    });
  }

  private onData(chunk: Buffer): void {
    if (this.closing || this.poisonError) return;
    const active = this.active;
    if (!active) {
      this.poison(new Error('aira-graphdb emitted a response without an active request'));
      return;
    }

    const newline = chunk.indexOf(0x0a);
    const frameChunk = newline === -1 ? chunk : chunk.subarray(0, newline);
    if (frameChunk.byteLength > 0) {
      this.frameChunks.push(frameChunk);
      this.frameBytes += frameChunk.byteLength;
    }
    if (this.frameBytes > active.maxResponseBytes) {
      this.poison(new Error(`aira-graphdb response exceeds ${active.maxResponseBytes} bytes`));
      return;
    }
    if (newline === -1) return;
    if (newline !== chunk.byteLength - 1) {
      this.poison(new Error('aira-graphdb emitted bytes after a complete response frame'));
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
      this.poison(new Error('aira-graphdb response has no active request'));
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(UTF8_DECODER.decode(frame)) as unknown;
    } catch (error) {
      this.poison(new Error(`aira-graphdb response is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }

    if (!isObject(parsed)
      || !Number.isSafeInteger(parsed.id)
      || typeof parsed.ok !== 'boolean'
      || parsed.id !== active.id) {
      this.poison(new Error('aira-graphdb response envelope or request ID is invalid'));
      return;
    }
    const response = parsed as unknown as RpcResponse;
    const expectedKeys = response.ok
      ? ['id', 'ok', 'result'] as const
      : ['id', 'ok', 'error'] as const;
    if (!hasExactKeys(parsed, expectedKeys)) {
      this.poison(new Error('aira-graphdb response envelope variant is invalid'));
      return;
    }
    this.active = undefined;
    if (!response.ok) {
      if (!isObject(response.error)
        || !hasExactKeys(response.error, ['code', 'message'])
        || typeof response.error.code !== 'string'
        || typeof response.error.message !== 'string') {
        this.active = active;
        this.poison(new Error('aira-graphdb error response is malformed'));
        return;
      }
      const code = response.error.code;
      const message = response.error.message;
      const error = new Error(message) as Error & { code?: string };
      error.code = code;
      this.emitTraffic(active, 'native-error', responseBytes);
      active.reject(error);
      this.pump();
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(response, 'result')) {
      this.active = active;
      this.poison(new Error('aira-graphdb success response has no result'));
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

  private poison(reason: unknown): void {
    if (this.poisonError || this.closing) return;
    this.poisonError = reason instanceof Error ? reason : new Error(String(reason));
    this.rejectQueued(this.poisonError);
    this.child.stdin.destroy();
    if (!this.child.killed) this.child.kill('SIGTERM');
  }
}
