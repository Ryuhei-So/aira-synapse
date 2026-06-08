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
}

interface EmbeddingApiResponse {
  readonly data?: ReadonlyArray<{
    readonly index: number;
    readonly embedding: readonly number[];
  }>;
}

const CACHE_LIMIT = 128;
const LOCAL_EMBEDDING_REQUIRED =
  'LOCAL_EMBEDDING_REQUIRED: local_only mode requires a local embedding provider';

export class OpenAIEmbeddingProvider implements IEmbeddingProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly cache = new Map<string, readonly number[]>();

  public constructor(options: OpenAIEmbeddingProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  }

  public async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    if (!this.apiKey.trim()) {
      throw new Error(LOCAL_EMBEDDING_REQUIRED);
    }

    if (request.texts.length === 0) {
      return { model: request.model ?? this.model, vectors: [], cached: true };
    }

    const model = request.model ?? this.model;
    const missing: string[] = [];

    for (const text of request.texts) {
      if (!this.cache.has(this.cacheKey(model, text))) {
        missing.push(text);
      }
    }

    if (missing.length > 0) {
      const response = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model, input: missing }),
      });

      if (!response.ok) {
        throw new Error(`OpenAI embeddings request failed with status ${response.status}`);
      }

      const body = (await response.json()) as EmbeddingApiResponse;
      const rows = [...(body.data ?? [])].sort((a, b) => a.index - b.index);
      rows.forEach((row, index) => {
        this.putCache(this.cacheKey(model, missing[index] ?? ''), row.embedding);
      });
    }

    return {
      model,
      vectors: request.texts.map((text) => this.cache.get(this.cacheKey(model, text)) ?? []),
      cached: missing.length === 0,
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
