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
import type { IMemoryStore } from '../../domain/storage/index.js';
import type { Passage } from '../../domain/memory/passage.js';
import type { Fact } from '../../domain/memory/fact.js';

const COMPARISON_PATTERNS = /\b(which|who is (more|less|taller|shorter|older|younger|bigger|smaller|larger|heavier|lighter)|(compare|comparison|differ|difference|between)\b.*\b(and|or|vs)\b|both\b)/i;

export class SimpleContextBuilder implements IContextBuilder {
  constructor(private readonly memoryStore: IMemoryStore) {}

  public async build(query: QueryRequest, ranking: PPRResult): Promise<ContextBundle> {
    const snapshot = await this.memoryStore.load(query.corpusId);
    const passageMap = new Map(snapshot.passages.map((p) => [p.passageId, p]));
    const factMap = new Map(snapshot.facts.map((f) => [f.factId, f]));

    const citedPassages: Passage[] = [];
    const citedFacts: Fact[] = [];

    for (const ranked of ranking.rankedPassages) {
      const passageId = ranked.nodeId.startsWith('passage:')
        ? ranked.nodeId.slice('passage:'.length)
        : ranked.nodeId;
      const passage = passageMap.get(passageId) ?? passageMap.get(ranked.nodeId);
      if (passage) citedPassages.push(passage);
    }

    for (const ranked of ranking.rankedEntities) {
      if (ranked.layer === 'fact') {
        const factId = ranked.nodeId.startsWith('fact:')
          ? ranked.nodeId.slice('fact:'.length)
          : ranked.nodeId;
        const fact = factMap.get(factId) ?? factMap.get(ranked.nodeId);
        if (fact) citedFacts.push(fact);
      }
    }

    // Detect comparison queries — fact-first ordering benefits entity relationship tasks
    const isComparison = COMPARISON_PATTERNS.test(query.text);

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
      if (tokenEstimate < tokenLimit * 0.9) {
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
