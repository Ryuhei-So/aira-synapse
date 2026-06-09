/**
 * Simple Context Builder.
 * Retrieves passage/fact texts for PPR-ranked nodes and builds a prompt context.
 */
import type {
  IContextBuilder,
  ContextBundle,
  PPRResult,
} from '../../domain/retrieval/ppr.js';
import type { QueryRequest } from '../../domain/retrieval/memoryFilter.js';
import type { IMemoryStore } from '../../domain/storage/index.js';
import type { Passage } from '../../domain/memory/passage.js';
import type { Fact } from '../../domain/memory/fact.js';

export class SimpleContextBuilder implements IContextBuilder {
  constructor(private readonly memoryStore: IMemoryStore) {}

  public async build(query: QueryRequest, ranking: PPRResult): Promise<ContextBundle> {
    const snapshot = await this.memoryStore.load(query.corpusId);
    const passageMap = new Map(snapshot.passages.map((p) => [p.passageId, p]));
    const factMap = new Map(snapshot.facts.map((f) => [f.factId, f]));

    const citedPassages: Passage[] = [];
    const citedFacts: Fact[] = [];

    // Collect top passages
    for (const ranked of ranking.rankedPassages) {
      const passageId = ranked.nodeId.startsWith('passage:')
        ? ranked.nodeId.slice('passage:'.length)
        : ranked.nodeId;
      const passage = passageMap.get(passageId) ?? passageMap.get(ranked.nodeId);
      if (passage) citedPassages.push(passage);
    }

    // Collect top facts
    for (const ranked of ranking.rankedEntities) {
      if (ranked.layer === 'fact') {
        const factId = ranked.nodeId.startsWith('fact:')
          ? ranked.nodeId.slice('fact:'.length)
          : ranked.nodeId;
        const fact = factMap.get(factId) ?? factMap.get(ranked.nodeId);
        if (fact) citedFacts.push(fact);
      }
    }

    // Build prompt context — passages first (more important for factoid QA),
    // then structured facts for relational reasoning
    let context = '';
    let tokenEstimate = 0;
    const tokenLimit = query.contextTokenLimit;

    // Passages first — they contain the raw text most likely to contain the answer
    if (citedPassages.length > 0) {
      context += '## Relevant Passages\n\n';
      for (const passage of citedPassages) {
        const block = `[${passage.metadata.documentId}] ${passage.text}\n\n`;
        const blockTokens = Math.ceil(block.length / 4);
        if (tokenEstimate + blockTokens > tokenLimit) break;
        context += block;
        tokenEstimate += blockTokens;
      }
    }

    // Facts second — structured triples for entity relationships
    if (citedFacts.length > 0 && tokenEstimate < tokenLimit * 0.9) {
      context += '## Key Facts\n\n';
      for (const fact of citedFacts) {
        const line = `- ${fact.headEntity} → ${fact.relation} → ${fact.tailEntity}\n`;
        const lineTokens = Math.ceil(line.length / 4);
        if (tokenEstimate + lineTokens > tokenLimit) break;
        context += line;
        tokenEstimate += lineTokens;
      }
      context += '\n';
    }

    const confidence = citedPassages.length > 0 || citedFacts.length > 0
      ? Math.min(1, (citedPassages.length * 0.3 + citedFacts.length * 0.1))
      : 0;

    return {
      promptContext: context,
      citedPassages,
      citedFacts,
      confidence,
    };
  }
}
