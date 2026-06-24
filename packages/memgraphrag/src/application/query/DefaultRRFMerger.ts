/**
 * Application Layer — Reciprocal Rank Fusion merger for federated query.
 * DES-FED-003: Merges multiple DB retrieval results with RRF scoring,
 * deduplication, contribution cap, and context budget enforcement.
 */

import type { Passage } from '../../domain/memory/passage.js';
import type { Fact } from '../../domain/memory/fact.js';
import type { RankedPassage, RankedFact } from '../../domain/retrieval/federation.js';
import type {
  IRRFMerger,
  NamespacedRetrievedContext,
  RRFConfig,
  MergedQueryContext,
  MergedPassage,
  MergedFact,
} from './federationTypes.js';
import { computePassageDedupeKey } from './textHash.js';

/** Approximate token count: ~4 chars per token. */
function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Approximate token count for a fact triple. */
function approxFactTokens(fact: Fact): number {
  return approxTokens(`${fact.headEntity} ${fact.relation} ${fact.tailEntity}`);
}

interface ScoredPassage {
  passage: Passage;
  rrfScore: number;
  sourceDbId: string;
  originalRank: number;
  dedupeKey: string;
  tokens: number;
}

interface ScoredFact {
  fact: Fact;
  rrfScore: number;
  sourceDbId: string;
  originalRank: number;
  factKey: string;
  tokens: number;
}

export class DefaultRRFMerger implements IRRFMerger {
  merge(
    contexts: readonly NamespacedRetrievedContext[],
    config: RRFConfig,
  ): MergedQueryContext {
    if (contexts.length === 0) {
      throw new Error('Cannot merge zero contexts');
    }

    // 1. Collect all passages with RRF scores
    const allPassages: ScoredPassage[] = [];
    for (const { dbId, context, weight } of contexts) {
      for (const rp of context.passages) {
        const rrfScore = weight * (1 / (config.k + rp.rank));
        allPassages.push({
          passage: rp.passage,
          rrfScore,
          sourceDbId: dbId,
          originalRank: rp.rank,
          dedupeKey: computePassageDedupeKey(rp.passage.metadata.sourceUrl, rp.passage.text),
          tokens: approxTokens(rp.passage.text),
        });
      }
    }

    // 2. Dedup: keep highest RRF score per dedup key
    const deduped = new Map<string, ScoredPassage>();
    for (const sp of allPassages) {
      const existing = deduped.get(sp.dedupeKey);
      if (!existing || sp.rrfScore > existing.rrfScore) {
        deduped.set(sp.dedupeKey, sp);
      }
    }
    const deduplicatedCount = allPassages.length - deduped.size;

    // 3. Sort by RRF score descending
    let sortedPassages = Array.from(deduped.values()).sort((a, b) => b.rrfScore - a.rrfScore);

    // 4. Contribution cap (token-based, relaxed for single DB)
    if (contexts.length > 1) {
      sortedPassages = this.applyContributionCap(sortedPassages, config.maxContributionRatio, config.contextTokenBudget);
    }

    // 5. Global topK cut
    sortedPassages = sortedPassages.slice(0, config.globalTopK);

    // 6. Collect all facts with RRF scores
    const allFacts: ScoredFact[] = [];
    for (const { dbId, context, weight } of contexts) {
      for (const rf of context.facts) {
        const rrfScore = weight * (1 / (config.k + rf.rank));
        allFacts.push({
          fact: rf.fact,
          rrfScore,
          sourceDbId: dbId,
          originalRank: rf.rank,
          factKey: rf.fact.factId,
          tokens: approxFactTokens(rf.fact),
        });
      }
    }

    // Dedup facts by factId
    const dedupedFacts = new Map<string, ScoredFact>();
    for (const sf of allFacts) {
      const existing = dedupedFacts.get(sf.factKey);
      if (!existing || sf.rrfScore > existing.rrfScore) {
        dedupedFacts.set(sf.factKey, sf);
      }
    }
    const sortedFacts = Array.from(dedupedFacts.values())
      .sort((a, b) => b.rrfScore - a.rrfScore)
      .slice(0, config.globalTopK);

    // 7. Build merged passages and facts
    const mergedPassages: MergedPassage[] = sortedPassages.map((sp) => ({
      passage: sp.passage,
      rrfScore: sp.rrfScore,
      sourceDbId: sp.sourceDbId,
      originalRank: sp.originalRank,
      approxTokens: sp.tokens,
    }));

    const mergedFacts: MergedFact[] = sortedFacts.map((sf) => ({
      fact: sf.fact,
      rrfScore: sf.rrfScore,
      sourceDbId: sf.sourceDbId,
      originalRank: sf.originalRank,
      approxTokens: sf.tokens,
    }));

    // 8. DB contribution counts
    const dbContributions: Record<string, number> = {};
    for (const mp of mergedPassages) {
      dbContributions[mp.sourceDbId] = (dbContributions[mp.sourceDbId] ?? 0) + 1;
    }

    // 9. Rebuild context from first successful context + merged data
    const baseCtx = contexts[0]!.context;

    // Build RankedPassage[] / RankedFact[] from merged data (invariant)
    const passages: RankedPassage[] = mergedPassages.map((mp, idx) => ({
      passage: mp.passage,
      score: mp.rrfScore,
      rank: idx + 1,
      dbId: mp.sourceDbId,
    }));

    const facts: RankedFact[] = mergedFacts.map((mf, idx) => ({
      fact: mf.fact,
      score: mf.rrfScore,
      rank: idx + 1,
      dbId: mf.sourceDbId,
    }));

    // Rebuild promptContext from merged passages and facts
    const promptContext = [
      ...mergedPassages.map((mp) => `Passage: ${mp.passage.text}`),
      ...mergedFacts.map((mf) => `Fact: ${mf.fact.headEntity} ${mf.fact.relation} ${mf.fact.tailEntity}`),
    ].join('\n');

    return {
      // RetrievedQueryContext base fields (from central prepare)
      passages,
      facts,
      pprResult: baseCtx.pprResult,
      contextBundle: {
        promptContext,
        citedPassages: mergedPassages.map((mp) => mp.passage),
        citedFacts: mergedFacts.map((mf) => mf.fact),
        confidence: mergedPassages[0]?.rrfScore ?? 0,
      },
      normalizedText: baseCtx.normalizedText,
      expandedRequest: baseCtx.expandedRequest,
      entityHits: baseCtx.entityHits,
      dictionaryHints: baseCtx.dictionaryHints,
      isComparison: baseCtx.isComparison,
      queryVector: baseCtx.queryVector,
      metrics: this.aggregateMetrics(contexts),
      // MergedQueryContext extensions
      mergedPassages,
      mergedFacts,
      dbContributions,
      deduplicatedCount,
    };
  }

  private applyContributionCap(
    passages: ScoredPassage[],
    maxRatio: number,
    tokenBudget: number,
  ): ScoredPassage[] {
    const maxTokensPerDb = Math.floor(tokenBudget * maxRatio);
    const dbTokens: Record<string, number> = {};
    const result: ScoredPassage[] = [];

    for (const sp of passages) {
      const current = dbTokens[sp.sourceDbId] ?? 0;
      if (current + sp.tokens <= maxTokensPerDb) {
        result.push(sp);
        dbTokens[sp.sourceDbId] = current + sp.tokens;
      }
    }

    return result;
  }

  private aggregateMetrics(
    contexts: readonly NamespacedRetrievedContext[],
  ): import('../../domain/retrieval/federation.js').RetrievalMetrics {
    let totalDictMatch = 0;
    let totalCited = 0;
    let totalLatency = 0;
    const allExpanded: string[] = [];
    let anyFallback = false;

    for (const { context } of contexts) {
      totalDictMatch += context.metrics.dictionaryMatchCount;
      totalCited += context.metrics.citedPassageCount;
      totalLatency = Math.max(totalLatency, context.metrics.latencyMs);
      allExpanded.push(...context.metrics.expandedTerms);
      if (context.metrics.fallbackTriggered) anyFallback = true;
    }

    return {
      dictionaryMatchCount: totalDictMatch,
      expandedTerms: [...new Set(allExpanded)],
      fallbackTriggered: anyFallback,
      pprIterations: 0,
      pprConverged: true,
      citedPassageCount: totalCited,
      latencyMs: totalLatency,
    };
  }
}
