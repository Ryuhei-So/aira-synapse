/**
 * Application Layer — 2-hop sub-query decomposition for bridge questions.
 * DES-MG3-013: Decomposes multi-hop questions into sequential sub-queries
 * to improve bridge-type question accuracy.
 */

import type { ILLMProvider } from '../../domain/provider/index.js';
import type { INodeInitializer, NodeInitializationRequest, NodeInitializationVector } from '../../domain/retrieval/memoryFilter.js';
import type { IGraphProjection, IPPR, PPRRequest } from '../../domain/retrieval/ppr.js';
import { isComparisonQuery, withTimeout } from './query-utils.js';

/** Regex patterns indicating bridge/chain questions */
const BRIDGE_PATTERNS = [
  /\bthe (?:person|one|man|woman|city|country|team|company|organization|film|movie|book|album|song|show|series|band|group|school|university) (?:who|that|which)\b/i,
  /\bwho(?:'s| is| was| has| had| did)\b.+\b(?:also|then|later|before|after)\b/i,
  /\bwhere (?:did|does|was|is)\b.+\b(?:who|that|which)\b/i,
  /\b(?:born|founded|located|headquartered|based) in\b.+\b(?:who|that|which)\b/i,
];

export type SubQueryFallbackReason =
  | 'comparison_query'
  | 'no_bridge_pattern'
  | 'llm_decomposition_failed'
  | 'hop1_retrieval_empty'
  | 'hop2_retrieval_empty'
  | 'deadline_exceeded'
  | 'llm_error';

export interface SubQueryResult {
  readonly mergedVector: NodeInitializationVector;
  readonly decomposed: boolean;
  readonly hop1FactCount: number;
  readonly hop2FactCount: number;
  readonly fallbackReason?: SubQueryFallbackReason;
}

interface LLMDecomposition {
  readonly hop1Query: string;
  readonly expectedBridgeType: string;
}

/** Merge weights for original, hop1, and hop2 vectors */
const W_ORIGINAL = 0.4;
const W_HOP1 = 0.3;
const W_HOP2 = 0.3;

/** Default deadline for the entire decomposition process */
const DEFAULT_DEADLINE_MS = 8000;

export class SubQueryDecomposer {
  constructor(
    private readonly llm: ILLMProvider,
    private readonly nodeInitializer: INodeInitializer,
    private readonly ppr: IPPR,
    private readonly projection: IGraphProjection,
    private readonly deadlineMs: number = DEFAULT_DEADLINE_MS,
  ) {}

  public async decompose(
    request: NodeInitializationRequest,
    baseVector: NodeInitializationVector,
  ): Promise<SubQueryResult> {
    const query = request.query.text;

    // Gate 1: Skip comparison queries
    if (isComparisonQuery(query)) {
      return this.fallback(baseVector, 'comparison_query');
    }

    // Gate 2: Require bridge pattern
    if (!BRIDGE_PATTERNS.some((p) => p.test(query))) {
      return this.fallback(baseVector, 'no_bridge_pattern');
    }

    // All steps wrapped in deadline
    const result = await withTimeout(
      this.executeDecomposition(request, baseVector, query),
      this.deadlineMs,
    );

    if (result === null) {
      return this.fallback(baseVector, 'deadline_exceeded');
    }

    return result;
  }

  private async executeDecomposition(
    request: NodeInitializationRequest,
    baseVector: NodeInitializationVector,
    query: string,
  ): Promise<SubQueryResult> {
    // Step 1: LLM decomposition
    let decomposition: LLMDecomposition;
    try {
      decomposition = await this.llmDecompose(query);
    } catch {
      return this.fallback(baseVector, 'llm_error');
    }

    if (!decomposition.hop1Query) {
      return this.fallback(baseVector, 'llm_decomposition_failed');
    }

    // Step 2: Hop-1 retrieval using decomposed sub-query
    const hop1Request: NodeInitializationRequest = {
      query: { ...request.query, text: decomposition.hop1Query },
      candidates: request.candidates,
    };
    const hop1Vector = await this.nodeInitializer.initialize(hop1Request);
    const hop1FactCount = Object.keys(hop1Vector.scores).filter((k) => k.startsWith('fact:')).length;

    if (hop1FactCount === 0) {
      return this.fallback(baseVector, 'hop1_retrieval_empty');
    }

    // Step 3: Extract bridge entity from hop-1 top scores
    const hop1PPRRequest: PPRRequest = {
      corpusId: request.query.corpusId,
      initialVector: hop1Vector,
      teleportProbability: 0.15,
      convergenceEpsilon: 1e-6,
      maxIterations: 50,
      topK: request.query.topK,
      topM: request.query.topM,
    };
    const hop1Ranking = await this.ppr.run(hop1PPRRequest, this.projection);

    // Get top entity from hop-1 results (bridge candidate)
    const topEntity = hop1Ranking.rankedEntities[0];
    if (!topEntity) {
      return this.fallback(baseVector, 'hop1_retrieval_empty');
    }

    // Step 4: Construct hop-2 query using bridge entity
    const bridgeEntityName = topEntity.nodeId.replace(/^fact:/, '');
    const hop2Query = `${query} [bridge: ${bridgeEntityName}]`;
    const hop2Request: NodeInitializationRequest = {
      query: { ...request.query, text: hop2Query },
      candidates: request.candidates,
    };
    const hop2Vector = await this.nodeInitializer.initialize(hop2Request);
    const hop2FactCount = Object.keys(hop2Vector.scores).filter((k) => k.startsWith('fact:')).length;

    if (hop2FactCount === 0) {
      return this.fallback(baseVector, 'hop2_retrieval_empty');
    }

    // Step 5: Merge vectors with weights
    const merged = this.mergeVectors(baseVector, hop1Vector, hop2Vector);

    return {
      mergedVector: merged,
      decomposed: true,
      hop1FactCount,
      hop2FactCount,
    };
  }

  private async llmDecompose(query: string): Promise<LLMDecomposition> {
    const prompt = `Decompose this multi-hop question into a first sub-question that identifies the bridge entity.

Question: ${query}

Respond in JSON:
{"hop1Query": "sub-question to find the bridge entity", "expectedBridgeType": "type of bridge entity (person/place/org/etc)"}`;

    const result = await this.llm.generate({
      prompt,
      temperature: 0.0,
      responseFormat: 'json',
      maxTokens: 200,
    });

    const parsed = JSON.parse(result.text) as LLMDecomposition;
    return parsed;
  }

  private mergeVectors(
    original: NodeInitializationVector,
    hop1: NodeInitializationVector,
    hop2: NodeInitializationVector,
  ): NodeInitializationVector {
    const merged: Record<string, number> = {};

    // Weighted merge
    for (const [key, score] of Object.entries(original.scores)) {
      merged[key] = (merged[key] ?? 0) + score * W_ORIGINAL;
    }
    for (const [key, score] of Object.entries(hop1.scores)) {
      merged[key] = (merged[key] ?? 0) + score * W_HOP1;
    }
    for (const [key, score] of Object.entries(hop2.scores)) {
      merged[key] = (merged[key] ?? 0) + score * W_HOP2;
    }

    // L1 normalize
    const sum = Object.values(merged).reduce((a, b) => a + b, 0);
    if (sum > 0) {
      for (const key of Object.keys(merged)) {
        merged[key] = merged[key]! / sum;
      }
    }

    return {
      scores: merged,
      fallbackTriggered: original.fallbackTriggered,
      injectedCount: original.injectedCount,
    };
  }

  private fallback(
    baseVector: NodeInitializationVector,
    reason: SubQueryFallbackReason,
  ): SubQueryResult {
    return {
      mergedVector: baseVector,
      decomposed: false,
      hop1FactCount: 0,
      hop2FactCount: 0,
      fallbackReason: reason,
    };
  }
}
