import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';

interface RpcRequest {
  id: number;
  method: string;
  params?: unknown;
}

interface RpcError {
  code: string;
  message: string;
}

interface RpcResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: RpcError;
}

function defaultCommand(dbPath: string): { command: string; args: string[] } {
  const fromEnv = process.env.AIRA_GRAPHDB_REPO_PATH;
  const repoPathCandidates = [
    fromEnv,
    resolve(process.cwd(), 'aira-graphdb'),
    resolve(process.cwd(), '..', 'aira-graphdb'),
    resolve(process.cwd(), '..', '..', 'aira-graphdb'),
    resolve(process.cwd(), '..', '..', '..', 'aira-graphdb'),
  ].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);
  const repoPath = repoPathCandidates.find((candidate) => existsSync(resolve(candidate, 'Cargo.toml')))
    ?? resolve(process.cwd(), '..', '..', '..', 'aira-graphdb');
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
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
  }>();
  private nextId = 1;

  public constructor(dbPath: string) {
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

    const lineReader = createInterface({ input: this.child.stdout });
    lineReader.on('line', (line) => this.onLine(line));
    this.child.on('error', (error) => this.rejectAll(error));
    this.child.on('exit', (code, signal) => {
      const details = this.stderrTail.length > 0
        ? `; stderr=${this.stderrTail}`
        : '';
      this.rejectAll(new Error(`aira-graphdb-native exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})${details}`));
    });
    this.child.stderr.on('data', (chunk) => {
      // Keep stderr consumed to avoid backpressure deadlocks.
      this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-4000);
    });
  }

  public async request<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId;
    this.nextId += 1;
    const payload: RpcRequest = { id, method, params };
    const encoded = `${JSON.stringify(payload)}\n`;

    return new Promise<T>((resolveRequest, rejectRequest) => {
      this.pending.set(id, { resolve: resolveRequest as (value: unknown) => void, reject: rejectRequest });
      this.child.stdin.write(encoded, (error) => {
        if (error) {
          this.pending.delete(id);
          rejectRequest(error);
        }
      });
    });
  }

  public async close(): Promise<void> {
    this.child.stdin.end();
    if (!this.child.killed) {
      this.child.kill('SIGTERM');
    }
  }

  private onLine(line: string): void {
    let response: RpcResponse;
    try {
      response = JSON.parse(line) as RpcResponse;
    } catch {
      return;
    }
    const resolver = this.pending.get(response.id);
    if (!resolver) return;
    this.pending.delete(response.id);
    if (!response.ok) {
      const code = response.error?.code ?? 'UNSUPPORTED_FEATURE';
      const message = response.error?.message ?? 'unknown native transport error';
      const error = new Error(message) as Error & { code?: string };
      error.code = code;
      resolver.reject(error);
      return;
    }
    resolver.resolve(response.result);
  }

  private rejectAll(reason: unknown): void {
    for (const [id, resolver] of this.pending.entries()) {
      this.pending.delete(id);
      resolver.reject(reason);
    }
  }
}
