/**
 * Application Layer — Federated Query Service.
 * DES-FED-002: Orchestrates parallel retrieval across multiple DBs,
 * RRF merge, and unified answer generation.
 */

import type { IEmbeddingProvider, ILLMProvider } from '../../domain/provider/index.js';
import type { QueryRequest } from '../../domain/retrieval/memoryFilter.js';
import type { RetrievedQueryContext, PreparedQuery } from '../../domain/retrieval/federation.js';
import type { QueryResponse, QueryService } from './QueryService.js';
import type { DefaultQueryService } from './QueryService.js';
import type {
  FederatedDbConfig,
  FederatedQueryConfig,
  IRRFMerger,
  FederatedDbMetric,
  FederatedDbResult,
} from './federationTypes.js';

/** Minimal closeable resource — avoids importing infrastructure StorageAdapters. */
interface Closeable {
  close(): Promise<void>;
}

type FederatedContext = RetrievedQueryContext & {
  readonly dbContributions?: Readonly<Record<string, number>>;
  readonly _perDbMetrics?: readonly FederatedDbMetric[];
  readonly mergedPassages?: readonly unknown[];
  readonly deduplicatedCount?: number;
};
import { FederatedQueryError, namespaceRankedPassage, namespaceRankedFact } from './federationTypes.js';
import { executeWithSoftTimeout } from './softTimeout.js';

export interface FederatedQueryServiceDependencies {
  readonly embeddingProvider: IEmbeddingProvider;
  readonly primaryService: DefaultQueryService;
  readonly dbFactory: (config: FederatedDbConfig) => Promise<{
    adapters: Closeable;
    queryService: DefaultQueryService;
  }>;
  readonly merger: IRRFMerger;
  readonly llm: ILLMProvider;
}

export class FederatedQueryService implements QueryService {
  private readonly dbInstances = new Map<string, { adapters: Closeable; queryService: DefaultQueryService }>();

  public constructor(
    private readonly config: FederatedQueryConfig,
    private readonly deps: FederatedQueryServiceDependencies,
  ) {}

  public async query(request: QueryRequest): Promise<QueryResponse> {
    const ctx = await this.retrieve(request);

    // Use primary service for answer generation with federation-specific policy
    const response = await this.deps.primaryService.answer(request, ctx);

    // Attach warnings from federation
    const warnings = this.buildWarnings(ctx);
    const federatedContext = ctx as FederatedContext;

    return {
      ...response,
      warnings: warnings.length > 0 ? warnings : undefined,
      metrics: {
        ...response.metrics,
        federationEnabled: true,
        federatedDbCount: this.config.databases.length,
        federatedSuccessCount: Object.keys(federatedContext.dbContributions ?? {}).length,
        federatedFailureCount: this.config.databases.length - Object.keys(federatedContext.dbContributions ?? {}).length,
        perDbMetrics: federatedContext._perDbMetrics,
        rrfMergedCount: federatedContext.mergedPassages?.length,
        rrfDeduplicatedCount: federatedContext.deduplicatedCount,
      },
    };
  }

  public async retrieve(
    request: QueryRequest,
    _precomputedVector?: readonly number[],
  ): Promise<RetrievedQueryContext> {
    // 1. Prepare query centrally (normalize, dict, thesaurus, comparison detect)
    const prepared = await this.deps.primaryService.prepare(request);

    // 2. Compute embedding once
    const { vectors } = await this.deps.embeddingProvider.embed({
      texts: [prepared.expandedRequest.text],
    });
    const queryVector = vectors[0];
    if (!queryVector || queryVector.length === 0) {
      throw new FederatedQueryError('Embedding returned empty vector', []);
    }

    // 3. Initialize DB instances
    await this.ensureDbInstances();

    // 4. Parallel retrieval with soft timeout
    const results = await this.executeParallelRetrieval(prepared, queryVector, request);

    // 5. Check for total failure
    const successes = results.filter((r) => r.status === 'success' && r.context);
    if (successes.length === 0) {
      throw new FederatedQueryError(
        'All databases failed or timed out',
        results.map((r) => ({ dbId: r.dbId, status: r.status, error: r.error })),
      );
    }

    // 6. Namespace all IDs
    const namespacedContexts = successes.map((r) => {
      const ctx = r.context!;
      return {
        dbId: r.dbId,
        context: {
          ...ctx,
          passages: ctx.passages.map((rp) => namespaceRankedPassage(r.dbId, rp)),
          facts: ctx.facts.map((rf) => namespaceRankedFact(r.dbId, rf)),
        },
        weight: this.config.databases.find((db) => db.dbId === r.dbId)?.weight ?? 1.0,
      };
    });

    // 7. Merge with RRF
    const merged = this.deps.merger.merge(namespacedContexts, {
      k: this.config.rrfK,
      globalTopK: this.config.globalTopK,
      maxContributionRatio: this.config.maxContributionRatio,
      contextTokenBudget: this.config.contextTokenBudget,
    });

    // Attach per-DB metrics for response
    const perDbMetrics: FederatedDbMetric[] = results.map((r) => ({
      dbId: r.dbId,
      status: r.status,
      latencyMs: r.latencyMs,
      hitCount: r.context?.passages.length ?? 0,
      error: r.error,
    }));

    return Object.assign(merged, { _perDbMetrics: perDbMetrics });
  }

  public async close(): Promise<void> {
    const closePromises = Array.from(this.dbInstances.values()).map((inst) =>
      inst.adapters.close().catch(() => { /* swallow */ }),
    );
    await Promise.all(closePromises);
    this.dbInstances.clear();
  }

  private async ensureDbInstances(): Promise<void> {
    for (const dbConfig of this.config.databases) {
      if (!this.dbInstances.has(dbConfig.dbId)) {
        const instance = await this.deps.dbFactory(dbConfig);
        this.dbInstances.set(dbConfig.dbId, instance);
      }
    }
  }

  private async executeParallelRetrieval(
    prepared: PreparedQuery,
    queryVector: readonly number[],
    request: QueryRequest,
  ): Promise<FederatedDbResult[]> {
    const promises = this.config.databases.map(async (dbConfig): Promise<FederatedDbResult> => {
      const instance = this.dbInstances.get(dbConfig.dbId);
      if (!instance) {
        return { dbId: dbConfig.dbId, status: 'failure', error: 'DB not initialized', latencyMs: 0 };
      }

      const dbPrepared: PreparedQuery = {
        ...prepared,
        expandedRequest: {
          ...prepared.expandedRequest,
          corpusId: dbConfig.corpusId ?? request.corpusId,
          topK: this.config.perDbTopK,
          topM: this.config.perDbTopK,
          contextTokenLimit: this.config.contextTokenBudget,
        },
      };

      const work = instance.queryService.retrievePrepared(dbPrepared, queryVector);
      const result = await executeWithSoftTimeout(
        work,
        this.config.perDbTimeoutMs,
        () => instance.adapters.close(),
      );

      if (result.status === 'success') {
        return {
          dbId: dbConfig.dbId,
          status: 'success',
          context: result.value,
          latencyMs: result.latencyMs,
        };
      }

      return {
        dbId: dbConfig.dbId,
        status: result.status,
        error: result.error,
        latencyMs: result.latencyMs,
      };
    });

    return Promise.all(promises);
  }

  private buildWarnings(ctx: RetrievedQueryContext): string[] {
    const warnings: string[] = [];
    const perDbMetrics = (ctx as FederatedContext)._perDbMetrics;
    if (perDbMetrics) {
      for (const m of perDbMetrics) {
        if (m.status === 'timeout') {
          warnings.push(`Database "${m.dbId}" timed out after ${m.latencyMs}ms`);
        } else if (m.status === 'failure') {
          warnings.push(`Database "${m.dbId}" failed: ${m.error ?? 'unknown error'}`);
        }
      }
    }
    return warnings;
  }
}
