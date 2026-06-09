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

/** Attenuation for entity-expanded (non-seed) facts */
const EXPANSION_ATTENUATION = 0.3;
/** Maximum number of expanded facts to add (prevent seed dilution) */
const MAX_EXPANSION_FACTS = 20;

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
    if (isComparison && this.memoryStore && candidates.facts.length > 0) {
      const snapshot = await this.memoryStore.load(query.corpusId);

      const seedEntities = new Map<string, number>();
      for (const c of candidates.facts) {
        const headKey = c.item.headEntity.toLowerCase();
        const tailKey = c.item.tailEntity.toLowerCase();
        seedEntities.set(headKey, Math.max(seedEntities.get(headKey) ?? 0, c.similarity));
        seedEntities.set(tailKey, Math.max(seedEntities.get(tailKey) ?? 0, c.similarity));
      }

      const expansionCandidates: { key: string; score: number }[] = [];
      for (const fact of snapshot.facts) {
        const factKey = `fact:${fact.factId}`;
        if (scores[factKey] !== undefined) continue;

        const headScore = seedEntities.get(fact.headEntity.toLowerCase());
        const tailScore = seedEntities.get(fact.tailEntity.toLowerCase());

        if (headScore !== undefined || tailScore !== undefined) {
          const entityScore = Math.max(headScore ?? 0, tailScore ?? 0);
          expansionCandidates.push({ key: factKey, score: entityScore * EXPANSION_ATTENUATION });
        }
      }

      expansionCandidates.sort((a, b) => b.score - a.score);
      for (const exp of expansionCandidates.slice(0, MAX_EXPANSION_FACTS)) {
        scores[exp.key] = exp.score;
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

    return {
      scores,
      fallbackTriggered: candidates.fallbackRequired,
    };
  }
}
