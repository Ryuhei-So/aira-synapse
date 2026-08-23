/**
 * Entity-Expanding Node Initializer (v4).
 *
 * Applies entity-based fact expansion selectively:
 *   - Comparison queries: expand via shared entities (improves entity relation coverage)
 *   - Bridge queries: no expansion (avoids noise from unrelated facts)
 *
 * Entity expansion links facts sharing head/tail entities, enabling
 * multi-hop reasoning through the PPR teleport vector.
 */
import type {
  INodeInitializer,
  NodeInitializationRequest,
  NodeInitializationVector,
} from '../../domain/retrieval/memoryFilter.js';
import type { IMemoryStore } from '../../domain/storage/index.js';
import {
  buildV15FactExpansionPlan,
  normalizeV15Entity,
  orderV15ScoreThenId,
} from '../../domain/retrieval/v15Plan.js';

const COMPARISON_PATTERNS = /\b(which|who is (more|less|taller|shorter|older|younger|bigger|smaller|larger|heavier|lighter)|(compare|comparison|differ|difference|between)\b.*\b(and|or|vs)\b|both\b)/i;

export class SimpleNodeInitializer implements INodeInitializer {
  constructor(private readonly memoryStore?: IMemoryStore) {}

  public async initialize(request: NodeInitializationRequest): Promise<NodeInitializationVector> {
    const scores: Record<string, number> = {};
    const { candidates, query } = request;

    // 1. Seed facts from vector search (full weight)
    for (const c of candidates.facts) {
      scores[`fact:${c.item.factId}`] = c.similarity;
    }

    // 2. Entity expansion — only for comparison queries where entity
    //    bridging improves coverage of both compared entities.
    const isComparison = COMPARISON_PATTERNS.test(query.text);
    const expansionPlan = buildV15FactExpansionPlan(candidates, isComparison);
    if (expansionPlan && this.memoryStore) {
      const snapshot = await this.memoryStore.load(query.corpusId);

      const seedEntities = new Map(expansionPlan.seedEntities.map((seed) => [seed.key, seed.score]));
      const excludedSeedFacts = new Set(expansionPlan.excludedSeedFactIds);

      const expansionCandidates: { id: string; score: number }[] = [];
      for (const fact of snapshot.facts) {
        const factKey = `fact:${fact.factId}`;
        if (excludedSeedFacts.has(fact.factId) || scores[factKey] !== undefined) continue;

        const headScore = seedEntities.get(normalizeV15Entity(fact.headEntity));
        const tailScore = seedEntities.get(normalizeV15Entity(fact.tailEntity));

        if (headScore !== undefined || tailScore !== undefined) {
          const entityScore = Math.max(headScore ?? 0, tailScore ?? 0);
          expansionCandidates.push({ id: fact.factId, score: entityScore * expansionPlan.attenuation });
        }
      }

      for (const exp of orderV15ScoreThenId(expansionCandidates).slice(0, expansionPlan.limit)) {
        scores[`fact:${exp.id}`] = exp.score;
      }
    }

    // 3. Passage nodes (full weight — primary info source in our graph)
    for (const c of candidates.passages) {
      scores[`passage:${c.item.passageId}`] = c.similarity;
    }

    // 4. Schema nodes (full weight)
    for (const c of candidates.ontology) {
      scores[`schema:${c.item.schemaId}`] = c.similarity;
    }

    // 5. Entity nodes excluded from PPR seeds — entity co-occurrence subgraph
    //    is too dense and traps score.

    return {
      scores,
      fallbackTriggered: candidates.fallbackRequired,
    };
  }
}
