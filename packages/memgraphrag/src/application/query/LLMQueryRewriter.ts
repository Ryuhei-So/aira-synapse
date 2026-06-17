/**
 * Application Layer — LLM-based query rewriting for multi-hop decomposition.
 * DES-MG4-005: Decomposes bridge queries into 2 sequential sub-queries,
 * executes each via PPR, and merges results.
 *
 * Key differences from v0.3.0 SubQueryDecomposer:
 * - Does NOT inject into PPR teleport vector (proven regression: -3.4%)
 * - Runs PPR twice (step1 + step2) with intermediate answer
 * - Full fallback on any failure (JSON parse, timeout, LLM error)
 */

import type { ILLMProvider } from '../../domain/provider/llmProvider.js';
import type { IMemoryFilter, INodeInitializer, QueryRequest } from '../../domain/retrieval/memoryFilter.js';
import type { IPPR, IGraphProjection, PPRResult, RankedNode } from '../../domain/retrieval/ppr.js';
import type { IQueryRewriter, RewriteRequest, RewriteResult, SubQuery } from '../../domain/retrieval/queryRewriter.js';
import type { GlobalMemory } from '../../domain/memory/globalMemory.js';
import type { MemoryLayer } from '../../domain/memory/types.js';

export interface QueryRewriterDependencies {
  readonly llm: ILLMProvider;
  readonly memoryFilter: IMemoryFilter;
  readonly nodeInitializer: INodeInitializer;
  readonly ppr: IPPR;
  readonly projection: IGraphProjection;
  readonly globalMemory: GlobalMemory;
  readonly timeoutMs?: number;
}

function buildDecompositionPrompt(query: string): string {
  return `Decompose this multi-hop question into sequential sub-queries.

Rules:
- Exactly 2 sub-queries
- Step 1 finds an intermediate entity/fact
- Step 2 uses step 1's result to find the final answer
- Use {step1} as placeholder in step 2 for the intermediate answer
- Output valid JSON only

Question: ${query}

Output format:
{"sub_queries": [{"step": 1, "query": "...", "purpose": "..."}, {"step": 2, "query": "... {step1} ...", "depends_on": 1, "purpose": "..."}]}

JSON:`;
}

function buildIntermediateAnswerPrompt(subQuery: string, context: string): string {
  return `Answer this question using ONLY the context below.
Give a short factual answer (1-5 words). No explanation.

Question: ${subQuery}
Context: ${context}

Answer:`;
}

export class LLMQueryRewriter implements IQueryRewriter {
  private readonly timeoutMs: number;

  constructor(private readonly deps: QueryRewriterDependencies) {
    this.timeoutMs = deps.timeoutMs ?? 5000;
  }

  async rewrite(request: RewriteRequest): Promise<RewriteResult> {
    try {
      return await this.rewriteInternal(request);
    } catch {
      return this.fallbackResult(request, 'unexpected_error');
    }
  }

  private async rewriteInternal(request: RewriteRequest): Promise<RewriteResult> {
    // 1. Decompose query into sub-queries
    const subQueries = await this.safeDecompose(request.query.text);
    if (!subQueries) {
      return this.fallbackResult(request, 'decomposition_failed');
    }

    // 2. Execute step 1 PPR
    const step1Query: QueryRequest = { ...request.query, text: subQueries[0]!.query };
    const step1Ranking = await this.executePPR(step1Query);

    // 3. Extract intermediate answer from step 1 results
    const intermediateAnswer = await this.extractIntermediate(subQueries[0]!.query, step1Ranking);
    if (!intermediateAnswer) {
      return this.fallbackResult(request, 'intermediate_extraction_failed');
    }

    // 4. Execute step 2 PPR with intermediate answer
    const step2Text = subQueries[1]!.query.replace('{step1}', intermediateAnswer);
    const step2Query: QueryRequest = { ...request.query, text: step2Text };
    const step2Ranking = await this.executePPR(step2Query);

    // 5. Merge rankings
    const mergedRanking = this.mergeRankings(step1Ranking, step2Ranking, request.query.topK);

    return {
      decomposed: true,
      subQueries,
      intermediateAnswers: [intermediateAnswer],
      mergedRanking,
      fallback: false,
    };
  }

  private async safeDecompose(query: string): Promise<SubQuery[] | null> {
    try {
      const result = await Promise.race([
        this.deps.llm.generate({
          prompt: buildDecompositionPrompt(query),
          responseFormat: 'json',
          reasoningEffort: 'low',
          verbosity: 'low',
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), this.timeoutMs),
        ),
      ]);

      const parsed = JSON.parse(result.text);
      const rawSubQueries = parsed.sub_queries;

      // Validation: exactly 2 subqueries
      if (!Array.isArray(rawSubQueries) || rawSubQueries.length !== 2) {
        return null;
      }

      // Step 1 validation
      if (rawSubQueries[0].step !== 1 || !rawSubQueries[0].query?.trim()) {
        return null;
      }

      // Step 2 validation: depends_on (snake_case from LLM) or dependsOn
      const raw2 = rawSubQueries[1];
      const dependsOn = raw2.depends_on ?? raw2.dependsOn;
      if (raw2.step !== 2 || dependsOn !== 1 || !raw2.query?.trim()) {
        return null;
      }
      if (!raw2.query.includes('{step1}')) {
        return null;
      }

      // Normalize to TypeScript interface
      return [
        { step: 1, query: rawSubQueries[0].query, purpose: rawSubQueries[0].purpose ?? '' },
        { step: 2, query: raw2.query, dependsOn: 1, purpose: raw2.purpose ?? '' },
      ];
    } catch {
      return null;
    }
  }

  private async extractIntermediate(subQuery: string, ranking: PPRResult): Promise<string | null> {
    const topNodes = ranking.rankedPassages.slice(0, 5);
    const passages = await Promise.all(
      topNodes.map(n => this.deps.globalMemory.getPassage(n.nodeId)),
    );
    const context = passages
      .filter((p): p is NonNullable<typeof p> => p !== null)
      .map(p => p.text)
      .join('\n\n');

    if (!context) return null;

    try {
      const result = await this.deps.llm.generate({
        prompt: buildIntermediateAnswerPrompt(subQuery, context),
        reasoningEffort: 'low',
        verbosity: 'low',
      });
      const answer = result.text.trim();
      return answer.length > 0 ? answer : null;
    } catch {
      return null;
    }
  }

  private async executePPR(query: QueryRequest): Promise<PPRResult> {
    const candidates = await this.deps.memoryFilter.filter(query);
    const vector = await this.deps.nodeInitializer.initialize({ query, candidates });
    return this.deps.ppr.run({
      corpusId: query.corpusId,
      initialVector: vector,
      teleportProbability: 0.5,
      convergenceEpsilon: 1e-6,
      maxIterations: 100,
      topK: query.topK,
      topM: query.topM,
    }, this.deps.projection);
  }

  private async fallbackResult(request: RewriteRequest, reason: string): Promise<RewriteResult> {
    const ranking = await this.executePPR(request.query);
    return {
      decomposed: false,
      subQueries: [],
      intermediateAnswers: [],
      mergedRanking: ranking,
      fallback: true,
      fallbackReason: reason,
    };
  }

  private mergeRankings(r1: PPRResult, r2: PPRResult, topK: number): PPRResult {
    // Normalize scores to [0, 1]
    const normalize = (nodes: readonly RankedNode[]): Map<string, { score: number; layer: MemoryLayer }> => {
      const maxScore = nodes.length > 0 ? nodes[0]!.score : 1;
      const map = new Map<string, { score: number; layer: MemoryLayer }>();
      for (const n of nodes) {
        map.set(n.nodeId, { score: maxScore > 0 ? n.score / maxScore : 0, layer: n.layer });
      }
      return map;
    };

    const scores1 = normalize(r1.rankedPassages);
    const scores2 = normalize(r2.rankedPassages);

    // Combine scores: step2 weighted higher (0.6) vs step1 (0.4), duplicates boosted (1.2x)
    const allIds = new Set([...scores1.keys(), ...scores2.keys()]);
    const combined: { nodeId: string; score: number; layer: MemoryLayer }[] = [];

    for (const id of allIds) {
      const s1 = scores1.get(id);
      const s2 = scores2.get(id);
      const score1 = s1?.score ?? 0;
      const score2 = s2?.score ?? 0;
      const boost = (score1 > 0 && score2 > 0) ? 1.2 : 1.0;
      const combinedScore = (score1 * 0.4 + score2 * 0.6) * boost;
      const layer = (s2?.layer ?? s1?.layer) as MemoryLayer;
      combined.push({ nodeId: id, score: combinedScore, layer });
    }

    combined.sort((a, b) => b.score - a.score);
    const capped = combined.slice(0, topK);

    return {
      rankedPassages: capped.map(c => ({ nodeId: c.nodeId, score: c.score, layer: c.layer })),
      rankedEntities: r2.rankedEntities,
      iterations: r1.iterations + r2.iterations,
      converged: r1.converged && r2.converged,
      l1Delta: Math.max(r1.l1Delta, r2.l1Delta),
    };
  }
}
