import { setTimeout as delay } from 'node:timers/promises';
import type { SemanticScholarCache } from './SemanticScholarCache.js';

export interface SemanticScholarPaper {
  readonly paperId: string;
  readonly title: string;
  readonly abstract: string;
  readonly year?: number;
  readonly venue?: string;
  readonly citationCount?: number;
  readonly url?: string;
}

export interface SemanticScholarSearchResponse {
  readonly total: number;
  readonly data: readonly SemanticScholarPaper[];
}

interface SemanticScholarClientOptions {
  readonly baseUrl?: string;
  readonly cache?: SemanticScholarCache;
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly maxRetries?: number;
  readonly rateLimitWindowMs?: number;
  readonly rateLimitMaxRequests?: number;
}

const DEFAULT_FIELDS = ['paperId', 'title', 'abstract', 'year', 'venue', 'citationCount', 'url'] as const;

function toPositiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function normalizePaper(value: Record<string, unknown>): SemanticScholarPaper {
  return {
    paperId: typeof value['paperId'] === 'string' ? value['paperId'] : 'unknown',
    title: typeof value['title'] === 'string' ? value['title'] : '',
    abstract: typeof value['abstract'] === 'string' ? value['abstract'] : '',
    year: typeof value['year'] === 'number' ? value['year'] : undefined,
    venue: typeof value['venue'] === 'string' ? value['venue'] : undefined,
    citationCount: typeof value['citationCount'] === 'number' ? value['citationCount'] : undefined,
    url: typeof value['url'] === 'string' ? value['url'] : undefined,
  };
}

export class SemanticScholarClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly rateLimitWindowMs: number;
  private readonly rateLimitMaxRequests: number;
  private readonly requestTimestamps: number[] = [];

  public constructor(private readonly options: SemanticScholarClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? 'https://api.semanticscholar.org/graph/v1';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => delay(ms));
    this.maxRetries = options.maxRetries ?? 3;
    this.rateLimitWindowMs = options.rateLimitWindowMs ?? 5 * 60 * 1000;
    this.rateLimitMaxRequests = options.rateLimitMaxRequests ?? 100;
  }

  public async searchPapers(
    query: string,
    fields: readonly string[] = DEFAULT_FIELDS,
    limit = 10,
  ): Promise<readonly SemanticScholarPaper[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return [];
    }

    const normalizedFields = [...new Set(fields.filter((field) => field.trim().length > 0))];
    const normalizedLimit = toPositiveInteger(limit, 10);
    const cacheKey = this.options.cache?.getKey(['searchPapers', normalizedQuery, normalizedFields, normalizedLimit]);
    const cached = cacheKey ? this.options.cache?.get<SemanticScholarSearchResponse>(cacheKey) : null;
    if (cached) {
      return cached.data;
    }

    await this.enforceRateLimit();

    const searchUrl = new URL(`${this.baseUrl}/paper/search`);
    searchUrl.searchParams.set('query', normalizedQuery);
    searchUrl.searchParams.set('fields', normalizedFields.join(','));
    searchUrl.searchParams.set('limit', String(normalizedLimit));

    const payload = await this.fetchWithRetry(searchUrl);
    const response: SemanticScholarSearchResponse = {
      total: typeof payload['total'] === 'number' ? payload['total'] : 0,
      data: Array.isArray(payload['data'])
        ? payload['data']
          .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object')
          .map((entry) => normalizePaper(entry))
        : [],
    };

    if (cacheKey) {
      this.options.cache?.set(cacheKey, response);
    }

    return response.data;
  }

  private async enforceRateLimit(now = Date.now()): Promise<void> {
    while (this.requestTimestamps.length > 0 && now - this.requestTimestamps[0]! >= this.rateLimitWindowMs) {
      this.requestTimestamps.shift();
    }

    if (this.requestTimestamps.length >= this.rateLimitMaxRequests) {
      const oldest = this.requestTimestamps[0] ?? now;
      const waitMs = Math.max(this.rateLimitWindowMs - (now - oldest), 0);
      if (waitMs > 0) {
        await this.sleep(waitMs);
      }
      const advancedNow = Math.max(now + waitMs, Date.now());
      while (this.requestTimestamps.length > 0 && advancedNow - this.requestTimestamps[0]! >= this.rateLimitWindowMs) {
        this.requestTimestamps.shift();
      }
      now = advancedNow;
    }

    this.requestTimestamps.push(now);
  }

  private async fetchWithRetry(url: URL): Promise<Record<string, unknown>> {
    let attempt = 0;
    let lastError: unknown;

    while (attempt <= this.maxRetries) {
      try {
        const response = await this.fetchImpl(url, {
          headers: {
            Accept: 'application/json',
          },
        });

        if (response.status === 429 || response.status >= 500) {
          const retryAfterHeader = response.headers.get('retry-after');
          const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : Number.NaN;
          const backoffMs = Number.isFinite(retryAfterSeconds)
            ? retryAfterSeconds * 1000
            : 2 ** attempt * 250;
          if (attempt >= this.maxRetries) {
            throw new Error(`Semantic Scholar request failed with status ${response.status}`);
          }
          await this.sleep(backoffMs);
          attempt += 1;
          continue;
        }

        if (!response.ok) {
          throw new Error(`Semantic Scholar request failed with status ${response.status}`);
        }

        const payload = await response.json() as unknown;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          throw new Error('Semantic Scholar returned an invalid payload');
        }
        return payload as Record<string, unknown>;
      } catch (error) {
        lastError = error;
        if (attempt >= this.maxRetries) {
          break;
        }
        await this.sleep(2 ** attempt * 250);
        attempt += 1;
      }
    }

    throw lastError instanceof Error ? lastError : new Error('Semantic Scholar request failed');
  }
}
