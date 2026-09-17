/**
 * Simple Context Builder.
 * Retrieves passage/fact texts for PPR-ranked nodes and builds a prompt context.
 * Adapts context ordering based on detected query type (comparison vs bridge).
 */
import type {
  IContextBuilder,
  ContextBundle,
  PPRResult,
} from '../../domain/retrieval/ppr.js';
import type { QueryRequest } from '../../domain/retrieval/memoryFilter.js';
import type { IMemoryReader } from '../../domain/storage/index.js';
import type { Passage } from '../../domain/memory/passage.js';
import type { Fact } from '../../domain/memory/fact.js';
import { isComparisonQuery } from './comparisonDetector.js';
import { indexById, lookupIds, resolveNode } from './memoryReadLookup.js';

export class SimpleContextBuilder implements IContextBuilder {
  constructor(private readonly memoryReader: IMemoryReader) {}

  public async build(query: QueryRequest, ranking: PPRResult): Promise<ContextBundle> {
    const rankedFacts = ranking.rankedEntities.filter((ranked) => ranked.layer === 'fact');
    const [passageRows, factRows] = await Promise.all([
      this.memoryReader.getPassagesByIds({
        corpusId: query.corpusId,
        passageIds: lookupIds(ranking.rankedPassages.map((ranked) => ranked.nodeId), 'passage:'),
      }),
      this.memoryReader.getFactsByIds({
        corpusId: query.corpusId,
        factIds: lookupIds(rankedFacts.map((ranked) => ranked.nodeId), 'fact:'),
      }),
    ]);
    const passageMap = indexById(passageRows, (p) => p.passageId);
    const factMap = indexById(factRows, (f) => f.factId);

    const citedPassages: Passage[] = [];
    const citedFacts: Fact[] = [];

    for (const ranked of ranking.rankedPassages) {
      const passage = resolveNode(passageMap, ranked.nodeId, 'passage:');
      if (passage) citedPassages.push(passage);
    }

    for (const ranked of rankedFacts) {
      const fact = resolveNode(factMap, ranked.nodeId, 'fact:');
      if (fact) citedFacts.push(fact);
    }

    // Detect comparison queries — fact-first ordering benefits entity relationship tasks
    const isComparison = isComparisonQuery(query.text);

    let context = '';
    let tokenEstimate = 0;
    const tokenLimit = query.contextTokenLimit;

    if (isComparison) {
      // Comparison: facts first (structured entity relations), then passages
      context += this.buildFactSection(citedFacts, tokenLimit, tokenEstimate);
      tokenEstimate = Math.ceil(context.length / 4);
      if (tokenEstimate < tokenLimit * 0.6) {
        context += this.buildPassageSection(citedPassages, tokenLimit, tokenEstimate);
      }
    } else {
      // Bridge/general: passages first (raw text for factoid answers), then facts
      context += this.buildPassageSection(citedPassages, tokenLimit, tokenEstimate);
      tokenEstimate = Math.ceil(context.length / 4);
      if (tokenEstimate < tokenLimit * 0.8) {
        context += this.buildFactSection(citedFacts, tokenLimit, tokenEstimate);
      }
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

  private buildPassageSection(passages: Passage[], tokenLimit: number, currentTokens: number): string {
    if (passages.length === 0) return '';
    let section = '## Relevant Passages\n\n';
    let tokens = currentTokens;
    for (const passage of passages) {
      const block = `[${passage.metadata.documentId}] ${passage.text}\n\n`;
      const blockTokens = Math.ceil(block.length / 4);
      if (tokens + blockTokens > tokenLimit) break;
      section += block;
      tokens += blockTokens;
    }
    return section;
  }

  private buildFactSection(facts: Fact[], tokenLimit: number, currentTokens: number): string {
    if (facts.length === 0) return '';
    let section = '## Key Facts\n\n';
    let tokens = currentTokens;
    for (const fact of facts) {
      const line = `- ${fact.headEntity} → ${fact.relation} → ${fact.tailEntity}\n`;
      const lineTokens = Math.ceil(line.length / 4);
      if (tokens + lineTokens > tokenLimit) break;
      section += line;
      tokens += lineTokens;
    }
    section += '\n';
    return section;
  }
}
