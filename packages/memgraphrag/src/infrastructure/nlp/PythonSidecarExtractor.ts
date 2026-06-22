/**
 * Infrastructure Layer — Python NLP sidecar adapter over JSON-RPC.
 * DES-MG-035: Lazy subprocess lifecycle with timeout-aware health checks.
 */

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from 'node:child_process';
import type {
  INLPExtractor,
  ISentenceChunker,
  NlpExtractionRequest,
  NlpExtractionResponse,
  ProviderHealth,
  SentenceChunk,
} from '../../domain/provider/llmProvider.js';

interface PythonSidecarExtractorOptions {
  readonly pythonCommand?: string;
  readonly scriptPath?: string;
  readonly requestTimeoutMs?: number;
  readonly healthcheckTimeoutMs?: number;
  readonly spawnImplementation?: (
    command: string,
    args: readonly string[],
    options: SpawnOptionsWithoutStdio,
  ) => ChildProcessWithoutNullStreams;
}

interface JsonRpcSuccess<TResult> {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly result: TResult;
}

interface JsonRpcError {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly error: {
    readonly code: number;
    readonly message: string;
  };
}

interface ExtractResult {
  readonly entities: NlpExtractionResponse['entities'];
  readonly nounPhrases: readonly string[];
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason?: unknown) => void;
  readonly timeout: NodeJS.Timeout;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_HEALTHCHECK_TIMEOUT_MS = 1_000;

export class PythonSidecarExtractor implements INLPExtractor, ISentenceChunker {
  private readonly pythonCommand: string;
  private readonly scriptPath: string;
  private readonly requestTimeoutMs: number;
  private readonly healthcheckTimeoutMs: number;
  private readonly spawnImplementation: NonNullable<
    PythonSidecarExtractorOptions['spawnImplementation']
  >;
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private stdoutBuffer = '';
  private lastErrorMessage = '';

  public constructor(options: PythonSidecarExtractorOptions = {}) {
    this.pythonCommand = options.pythonCommand ?? 'python3';
    this.scriptPath = options.scriptPath
      ?? resolve(import.meta.dirname, '../../../python/sidecar/server.py');
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.healthcheckTimeoutMs =
      options.healthcheckTimeoutMs ?? DEFAULT_HEALTHCHECK_TIMEOUT_MS;
    this.spawnImplementation = options.spawnImplementation ?? spawn;
  }

  public async extract(
    request: NlpExtractionRequest,
  ): Promise<NlpExtractionResponse> {
    const result = await this.callRpc<ExtractResult>(
      'extract',
      { text: request.text, language: request.language },
      this.requestTimeoutMs,
    );

    return {
      language: request.language,
      entities: result.entities,
      nounPhrases: result.nounPhrases,
    };
  }

  /**
   * Split Japanese text into sentence-aware chunks using GINZA.
   * Each chunk respects sentence boundaries and stays within maxTokens.
   */
  public async chunkSentences(
    text: string,
    maxTokens = 500,
  ): Promise<readonly SentenceChunk[]> {
    const result = await this.callRpc<{ chunks: SentenceChunk[] }>(
      'chunk_sentences',
      { text, maxTokens },
      this.requestTimeoutMs * 3, // longer timeout for large docs
    );
    return result.chunks;
  }

  /**
   * Extract NER entities and noun phrases from Japanese text using GINZA.
   */
  public async extractEntitiesJa(
    text: string,
  ): Promise<NlpExtractionResponse> {
    const result = await this.callRpc<ExtractResult>(
      'extract_entities_ja',
      { text },
      this.requestTimeoutMs * 2,
    );
    return {
      language: 'ja',
      entities: result.entities,
      nounPhrases: result.nounPhrases,
    };
  }

  public async healthCheck(): Promise<ProviderHealth> {
    try {
      await this.callRpc('health', {}, this.healthcheckTimeoutMs);
      return { healthy: true, message: 'Python sidecar is healthy' };
    } catch (error) {
      return {
        healthy: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  public async shutdown(): Promise<void> {
    this.failPending(new Error('Python sidecar shutdown requested'));
    this.killChild();
  }

  private ensureProcess(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) {
      return this.child;
    }

    this.child = this.spawnImplementation(
      this.pythonCommand,
      [this.scriptPath],
      { stdio: 'pipe' },
    );
    this.stdoutBuffer = '';
    this.lastErrorMessage = '';

    this.child.stdout.on('data', (chunk: Buffer | string) => {
      this.handleStdout(chunk.toString());
    });
    this.child.stderr.on('data', (chunk: Buffer | string) => {
      const message = chunk.toString().trim();
      if (message.length > 0) {
        this.lastErrorMessage = message;
      }
    });
    this.child.on('error', (error) => {
      this.failPending(error);
      this.child = undefined;
    });
    this.child.on('exit', (code, signal) => {
      this.failPending(
        new Error(
          this.lastErrorMessage
            || `Python sidecar exited before responding (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
        ),
      );
      this.child = undefined;
    });

    return this.child;
  }

  private async callRpc<TResult>(
    method: string,
    params: Readonly<Record<string, unknown>>,
    timeoutMs: number,
  ): Promise<TResult> {
    const child = this.ensureProcess();
    const id = this.nextId++;

    return await new Promise<TResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        this.killChild();
        reject(new Error(`Python sidecar request timed out for method ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as TResult),
        reject,
        timeout,
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', method, params, id })}\n`,
      );
    });
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;

    let newlineIndex = this.stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);

      if (line.length > 0) {
        this.handleResponse(line);
      }
      newlineIndex = this.stdoutBuffer.indexOf('\n');
    }
  }

  private handleResponse(line: string): void {
    let parsed: JsonRpcSuccess<unknown> | JsonRpcError;
    try {
      parsed = JSON.parse(line) as JsonRpcSuccess<unknown> | JsonRpcError;
    } catch {
      return;
    }

    const request = this.pending.get(parsed.id);
    if (!request) {
      return;
    }

    clearTimeout(request.timeout);
    this.pending.delete(parsed.id);

    if ('error' in parsed) {
      request.reject(new Error(parsed.error.message));
      return;
    }

    request.resolve(parsed.result);
  }

  private killChild(): void {
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
    this.child = undefined;
  }

  private failPending(error: unknown): void {
    for (const [id, request] of this.pending) {
      clearTimeout(request.timeout);
      request.reject(error);
      this.pending.delete(id);
    }
  }
}
