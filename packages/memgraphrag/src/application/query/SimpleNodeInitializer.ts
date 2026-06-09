/**
 * Simple Node Initializer.
 * Converts FilteredMemoryCandidates into a score vector for PPR.
 */
import type {
  INodeInitializer,
  NodeInitializationRequest,
  NodeInitializationVector,
} from '../../domain/retrieval/memoryFilter.js';

export class SimpleNodeInitializer implements INodeInitializer {
  public async initialize(request: NodeInitializationRequest): Promise<NodeInitializationVector> {
    const scores: Record<string, number> = {};
    const { candidates } = request;

    for (const c of candidates.passages) {
      scores[`passage:${c.item.passageId}`] = c.similarity;
    }
    for (const c of candidates.facts) {
      scores[`fact:${c.item.factId}`] = c.similarity;
    }
    for (const c of candidates.ontology) {
      scores[`schema:${c.item.schemaId}`] = c.similarity;
    }

    return {
      scores,
      fallbackTriggered: candidates.fallbackRequired,
    };
  }
}
