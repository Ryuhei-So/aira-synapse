/**
 * Application Layer — LLM-based passage reranking.
 * DES-MG4-006 (REQ-MG4-007): Reorders top-N PPR passages by LLM relevance scoring.
 *
 * - Single batch LLM call with all passage snippets
 * - Full fallback on LLM error or parse failure
 * - All passages preserved (order-only change, no drops)
 */

import type { ILLMProvider } from '../../domain/provider/llmProvider.js';
import type { GlobalMemory } from '../../domain/memory/globalMemory.js';
import type { RankedNode } from '../../domain/retrieval/ppr.js';
import type { IPassageReranker, RerankRequest, RerankResult } from '../../domain/retrieval/passageReranker.js';

export class LLMPassageReranker implements IPassageReranker {
  constructor(
    private readonly llm: ILLMProvider,
    private readonly globalMemory: GlobalMemory,
  ) {}

  async rerank(request: RerankRequest): Promise<RerankResult> {
    const startTime = Date.now();
    const topPassages = request.ranking.rankedPassages.slice(0, request.topN);

    if (topPassages.length === 0) {
      return this.fallbackResult(request, startTime);
    }

    // Resolve passage texts via GlobalMemory
    const passageTexts = await Promise.all(
      topPassages.map(async (node) => {
        const passage = await this.globalMemory.getPassage(node.nodeId);
        return passage?.text?.slice(0, 200) ?? `[passage ${node.nodeId}]`;
      }),
    );

    // Single batch LLM call
    const prompt = this.buildRerankPrompt(request.query, passageTexts);
    let response;
    try {
      response = await this.llm.generate({
        prompt,
        temperature: 0.0,
        reasoningEffort: 'low',
        verbosity: 'low',
      });
    } catch {
      return this.fallbackResult(request, startTime);
    }

    const scores = this.parseScores(response.text, topPassages.length);
    if (!scores) {
      return this.fallbackResult(request, startTime);
    }

    // Sort by score, preserve all passages
    const scored = topPassages.map((node, i) => ({ node, score: scores[i]! }));
    scored.sort((a, b) => b.score - a.score);

    const reranked = scored.slice(0, request.selectN).map(s => s.node);
    const unselectedTopN = scored.slice(request.selectN).map(s => s.node);
    const remaining = request.ranking.rankedPassages.slice(request.topN);
    const allPassages: RankedNode[] = [...reranked, ...unselectedTopN, ...remaining];

    const positionChanges = scored.filter(
      (s, i) => s.node.nodeId !== topPassages[i]!.nodeId,
    ).length;

    return {
      rerankedPPRResult: {
        ...request.ranking,
        rankedPassages: allPassages,
      },
      metrics: {
        positionChanges,
        scoreRange: this.computeScoreRange(scores),
        latencyMs: Date.now() - startTime,
        tokensUsed: response.usage.inputTokens + response.usage.outputTokens,
      },
    };
  }

  private fallbackResult(request: RerankRequest, startTime: number): RerankResult {
    return {
      rerankedPPRResult: request.ranking,
      metrics: {
        positionChanges: 0,
        scoreRange: { min: 0, max: 0, median: 0 },
        latencyMs: Date.now() - startTime,
        tokensUsed: 0,
      },
    };
  }

  private buildRerankPrompt(query: string, passageTexts: readonly string[]): string {
    const passageList = passageTexts.map((text, i) => `[${i}] ${text}`).join('\n');
    return `Rate the relevance of each passage to the query on a scale of 0-10.

Query: ${query}

Passages:
${passageList}

Output JSON only: {"scores": [score_for_0, score_for_1, ...]}`;
  }

  private parseScores(text: string, expectedLength: number): number[] | null {
    try {
      // Handle potential markdown wrapping
      const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed.scores) || parsed.scores.length !== expectedLength) {
        return null;
      }
      return parsed.scores.map((s: unknown) => (typeof s === 'number' ? s : 0));
    } catch {
      return null;
    }
  }

  private computeScoreRange(scores: number[]): { min: number; max: number; median: number } {
    const sorted = [...scores].sort((a, b) => a - b);
    return {
      min: sorted[0] ?? 0,
      max: sorted[sorted.length - 1] ?? 0,
      median: sorted[Math.floor(sorted.length / 2)] ?? 0,
    };
  }
}
