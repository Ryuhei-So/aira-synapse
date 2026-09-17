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
import type { Fact } from '../../domain/memory/fact.js';
import type { IMemoryReader } from '../../domain/storage/index.js';
import {
  buildV15FactExpansionPlan,
  buildV15InitialVector,
  compileV15FactExpansionEvaluator,
  orderV15ScoreThenId,
} from '../../domain/retrieval/v15Plan.js';
import { isComparisonQuery } from './comparisonDetector.js';

export class SimpleNodeInitializer implements INodeInitializer {
  constructor(private readonly memoryReader?: IMemoryReader) {}

  public async initialize(request: NodeInitializationRequest): Promise<NodeInitializationVector> {
    const { candidates, query } = request;
    const expandedFacts: { factId: string; score: number }[] = [];

    // 2. Entity expansion — only for comparison queries where entity
    //    bridging improves coverage of both compared entities.
    const isComparison = isComparisonQuery(query.text);
    const expansionPlan = buildV15FactExpansionPlan(candidates, isComparison);
    if (expansionPlan && this.memoryReader) {
      // The backend scans its facts for the seed entities (head or tail
      // equal under the pinned Unicode 16 case fold); the v15 evaluator
      // still owns seed exclusion, scoring, attenuation, order and the cap.
      const seedEntities = uniqueSeedEntities(candidates.facts.map((candidate) => candidate.item));
      const matchingFacts = await findExpansionFacts(this.memoryReader, query.corpusId, seedEntities);
      const evaluateExpansion = compileV15FactExpansionEvaluator(expansionPlan);

      const expansionCandidates: { id: string; score: number }[] = [];
      for (const fact of matchingFacts) {
        const evaluated = evaluateExpansion(fact);
        if (evaluated) expansionCandidates.push({ id: evaluated.factId, score: evaluated.score });
      }

      for (const exp of orderV15ScoreThenId(expansionCandidates).slice(0, expansionPlan.limit)) {
        expandedFacts.push({ factId: exp.id, score: exp.score });
      }
    }
    return buildV15InitialVector(candidates, expandedFacts);
  }
}

function uniqueSeedEntities(facts: readonly Fact[]): string[] {
  const entities = new Set<string>();
  for (const fact of facts) {
    entities.add(fact.headEntity);
    entities.add(fact.tailEntity);
  }
  return [...entities];
}

/**
 * All stored facts (any state, as the legacy whole-snapshot scan saw them)
 * mentioning a seed entity. One batched read covers the common case; when
 * that reply is saturated at the advertised limit, each entity is re-read
 * on its own so a frequent entity cannot hide another entity's facts. An
 * entity with more matching facts than the limit is still truncated to its
 * first `limit` by factId; that residual is recorded in the PR body.
 */
async function findExpansionFacts(
  memoryReader: IMemoryReader,
  corpusId: string,
  entities: readonly string[],
): Promise<readonly Fact[]> {
  const limit = memoryReader.bounds.maxLimit;
  const batched = await memoryReader.findFactsByEntities({ corpusId, entities, state: 'any', limit });
  if (batched.length < limit || entities.length <= 1) return batched;

  const byId = new Map<string, Fact>();
  for (const entity of entities) {
    const facts = await memoryReader.findFactsByEntities({ corpusId, entities: [entity], state: 'any', limit });
    for (const fact of facts) byId.set(fact.factId, fact);
  }
  return [...byId.values()];
}
