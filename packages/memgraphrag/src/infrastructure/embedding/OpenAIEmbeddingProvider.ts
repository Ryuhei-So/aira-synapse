/**
 * Infrastructure Layer — OpenAI-compatible embedding provider.
 * DES-MG-034: Fetch-based batch embeddings with in-memory LRU cache.
 */

import type {
  EmbeddingRequest,
  EmbeddingResponse,
  IEmbeddingProvider,
  ProviderHealth,
} from '../../domain/provider/llmProvider.js';

interface OpenAIEmbeddingProviderOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly dimensions?: number;
  /**
   * Maximum number of texts per /embeddings request. A document's chunks used
   * to travel in one request, so a long document (190 chunks of 900 tokens on
   * a CPU embedder at ~400 tokens/s) could not finish inside any per-request
   * deadline and tripped the caller's infrastructure circuit
   * (literature-hub #575). Bounded batches keep each request's cost
   * proportional to the batch, not to the document.
   */
  readonly batchSize?: number;
}

export const DEFAULT_EMBEDDING_BATCH_SIZE = 32;

interface EmbeddingApiResponse {
  readonly data?: ReadonlyArray<{
    readonly index: number;
    readonly embedding: readonly number[];
  }>;
}

const CACHE_LIMIT = 8192;
const LOCAL_EMBEDDING_REQUIRED =
  'LOCAL_EMBEDDING_REQUIRED: local_only mode requires a local embedding provider';

export class OpenAIEmbeddingProvider implements IEmbeddingProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly dimensions: number | undefined;
  private readonly batchSize: number;
  private readonly cache = new Map<string, readonly number[]>();

  public constructor(options: OpenAIEmbeddingProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.dimensions = options.dimensions;
    const batchSize = options.batchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE;
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new Error(`embedding batchSize must be a positive integer, got ${String(options.batchSize)}`);
    }
    this.batchSize = batchSize;
  }

  public async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    if (!this.apiKey.trim()) {
      throw new Error(LOCAL_EMBEDDING_REQUIRED);
    }

    if (request.texts.length === 0) {
      return { model: request.model ?? this.model, vectors: [], cached: true };
    }

    const model = request.model ?? this.model;

    // Partition texts into cached and uncached
    const resultVectors: (readonly number[])[] = new Array(request.texts.length);
    const missingIndices: number[] = [];
    const missingTexts: string[] = [];

    for (let i = 0; i < request.texts.length; i++) {
      const cached = this.cache.get(this.cacheKey(model, request.texts[i]!));
      if (cached) {
        resultVectors[i] = cached;
      } else {
        missingIndices.push(i);
        missingTexts.push(request.texts[i]!);
      }
    }

    // One request per batch: a failure or deadline in one batch cannot retry
    // work another batch already finished, and each request's cost is bounded
    // by batchSize rather than by the caller's document.
    for (let start = 0; start < missingTexts.length; start += this.batchSize) {
      const batchTexts = missingTexts.slice(start, start + this.batchSize);
      const batchIndices = missingIndices.slice(start, start + this.batchSize);
      // Truncate inputs that may exceed model token limit (8191 for text-embedding-3-*)
      const MAX_INPUT_CHARS = 7000;
      const truncatedTexts = batchTexts.map(t =>
        t.length > MAX_INPUT_CHARS ? t.slice(0, MAX_INPUT_CHARS) : t
      );

      const maxRetries = 3;
      let lastError: Error | undefined;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const response = await fetch(`${this.baseUrl}/embeddings`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({
              model,
              input: truncatedTexts,
              ...(this.dimensions ? { dimensions: this.dimensions } : {}),
            }),
          });

          if (!response.ok) {
            const errorBody = await response.text().catch(() => '');
            throw new Error(`OpenAI embeddings request failed with status ${response.status}: ${errorBody}`);
          }

          const body = (await response.json()) as EmbeddingApiResponse;
          const rows = [...(body.data ?? [])].sort((a, b) => a.index - b.index);
          if (rows.length !== batchTexts.length) {
            throw new Error(`OpenAI embeddings response returned ${rows.length} vectors for ${batchTexts.length} inputs`);
          }
          for (let j = 0; j < rows.length; j++) {
            const embedding = rows[j]!.embedding;
            const originalIdx = batchIndices[j]!;
            resultVectors[originalIdx] = embedding;
            this.putCache(this.cacheKey(model, batchTexts[j]!), embedding);
          }
          lastError = undefined;
          break;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          if (attempt < maxRetries - 1) {
            await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          }
        }
      }
      if (lastError) throw lastError;
    }

    return {
      model,
      vectors: resultVectors.map(v => v ?? []),
      cached: missingTexts.length === 0,
    };
  }

  public async healthCheck(): Promise<ProviderHealth> {
    if (!this.apiKey.trim()) {
      return { healthy: false, message: LOCAL_EMBEDDING_REQUIRED };
    }

    return { healthy: true, message: `OpenAI embeddings configured for ${this.model}` };
  }

  private cacheKey(model: string, text: string): string {
    return `${model}:${text}`;
  }

  private putCache(key: string, vector: readonly number[]): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    this.cache.set(key, vector);

    if (this.cache.size > CACHE_LIMIT) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }
  }
}
