import type { IEmbeddingProvider } from '../../domain/provider/index.js';
import type { QueryFeatureFlags } from '../../domain/config/featureFlags.js';
import { DEFAULT_QUERY_FLAGS } from '../../domain/config/featureFlags.js';
import type { QueryRequest } from '../../domain/retrieval/memoryFilter.js';
import {
  assertV15FeatureProfile,
  assertV15PlanningRequest,
  assertV15QueryVector,
  buildV15RetrievalRequestPlan,
  type V15RetrievalRequestPlan,
} from '../../domain/retrieval/v15Plan.js';
import { isComparisonQuery } from './comparisonDetector.js';
import {
  DEFAULT_HYPER_PARAMS,
  DEFAULT_PPR_CONVERGENCE_EPSILON,
  DEFAULT_PPR_MAX_ITERATIONS,
  normalizeV15QueryText,
  type QueryHyperParams,
} from './QueryService.js';

export interface BoundedQueryPlanner {
  plan(request: QueryRequest): Promise<V15RetrievalRequestPlan>;
}

export interface BoundedQueryPlannerDependencies {
  readonly embeddingProvider: IEmbeddingProvider;
  readonly hyperParams?: QueryHyperParams;
  readonly featureFlags?: QueryFeatureFlags;
}

/**
 * GraphDB-free V15 planning. Unsupported profiles and malformed requests are
 * rejected before the provider call; provider output is validated before a
 * plan can cross the Hub/native boundary.
 */
export class DefaultBoundedQueryPlanner implements BoundedQueryPlanner {
  private readonly hp: QueryHyperParams;
  private readonly flags: QueryFeatureFlags;

  public constructor(private readonly dependencies: BoundedQueryPlannerDependencies) {
    this.hp = dependencies.hyperParams ?? DEFAULT_HYPER_PARAMS;
    this.flags = dependencies.featureFlags ?? DEFAULT_QUERY_FLAGS;
  }

  public async plan(request: QueryRequest): Promise<V15RetrievalRequestPlan> {
    assertV15FeatureProfile(this.flags);
    assertV15PlanningRequest(request);
    const normalizedText = normalizeV15QueryText(request.text);
    if (normalizedText.length === 0) {
      throw new TypeError('query.text must contain a non-whitespace character');
    }
    const expandedRequest = { ...request, text: normalizedText };
    const response = await this.dependencies.embeddingProvider.embed({ texts: [normalizedText] });
    const queryVector = response.vectors[0];
    assertV15QueryVector(queryVector);
    return buildV15RetrievalRequestPlan(expandedRequest, queryVector, {
      comparisonMode: isComparisonQuery(normalizedText),
      featureFlags: this.flags,
      teleportProbability: this.hp.teleportProbability,
      convergenceEpsilon: DEFAULT_PPR_CONVERGENCE_EPSILON,
      maxIterations: DEFAULT_PPR_MAX_ITERATIONS,
      hubDegreeThreshold: this.hp.hubDegreeThreshold,
    });
  }
}
