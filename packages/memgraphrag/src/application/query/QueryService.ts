import type { DictionaryMatch, ITermDictionary } from '../../domain/dictionary/index.js';
import type { ILLMProvider } from '../../domain/provider/index.js';
import type {
  IMemoryFilter,
  INodeInitializer,
  QueryRequest,
} from '../../domain/retrieval/memoryFilter.js';
import type {
  ContextBundle,
  IContextBuilder,
  IGraphProjection,
  IPPR,
  PPRResult,
} from '../../domain/retrieval/ppr.js';
import type { Fact } from '../../domain/memory/fact.js';
import type { Passage } from '../../domain/memory/passage.js';
import { ThesaurusExpansionPolicy } from './ThesaurusExpansionPolicy.js';
import { TemplateResponseGenerator } from './TemplateResponseGenerator.js';
import { isComparisonQuery } from './comparisonDetector.js';

export interface CitationDto {
  readonly passageId: string;
  readonly title: string;
  readonly sourceUrl: string;
  readonly snippet: string;
}

export interface EntityHit {
  readonly term: string;
  readonly matchedText: string;
  readonly boostFactor: number;
}

export interface QueryMetrics {
  readonly dictionaryMatchCount: number;
  readonly expandedTerms: readonly string[];
  readonly fallbackTriggered: boolean;
  readonly pprIterations: number;
  readonly pprConverged: boolean;
  readonly citedPassageCount: number;
  readonly llmInputTokens: number;
  readonly llmOutputTokens: number;
  readonly scVotes?: readonly string[];
}

export interface QueryResponse {
  readonly response: string;
  readonly citations: readonly CitationDto[];
  readonly entities: readonly EntityHit[];
  readonly metrics: QueryMetrics;
}

export interface QueryService {
  query(request: QueryRequest): Promise<QueryResponse>;
}

/** Tunable hyperparameters for query pipeline optimization. */
export interface QueryHyperParams {
  readonly teleportProbability: number;   // PPR teleport (default: 0.5)
  readonly scTemperature: number;         // Self-consistency temperature (default: 0.3)
  readonly scSamples: number;             // Number of SC samples (default: 3, 1=disabled)
  readonly hubDegreeThreshold: number;    // PPR hub damping threshold (default: 50)
}

export const DEFAULT_HYPER_PARAMS: QueryHyperParams = {
  teleportProbability: 0.5,
  scTemperature: 0.0,
  scSamples: 1,
  hubDegreeThreshold: 50,
};

export interface QueryServiceDependencies {
  readonly dictionary: ITermDictionary;
  readonly expansionPolicy: ThesaurusExpansionPolicy | { expandQuery(query: string): Promise<{ expandedTerms: readonly string[]; rewrittenQuery: string; originalQuery: string }>; };
  readonly memoryFilter: IMemoryFilter;
  readonly nodeInitializer: INodeInitializer;
  readonly ppr: IPPR;
  readonly projection: IGraphProjection;
  readonly contextBuilder: IContextBuilder;
  readonly llm: ILLMProvider;
  readonly responseGenerator?: TemplateResponseGenerator;
  readonly hyperParams?: QueryHyperParams;
}

function normalizeQueryText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function toEntityHits(matches: readonly DictionaryMatch[]): readonly EntityHit[] {
  return matches.map((match) => ({
    term: match.entry.canonicalForm,
    matchedText: match.matchedText,
    boostFactor: match.boostFactor,
  }));
}

function toCitations(bundle: ContextBundle): readonly CitationDto[] {
  return bundle.citedPassages.map((passage) => ({
    passageId: passage.passageId,
    title: passage.metadata.title,
    sourceUrl: passage.metadata.sourceUrl,
    snippet: passage.text,
  }));
}

function shouldUseTemplateFallback(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes('feature_requires_api')
    || message.includes('provider')
    || message.includes('openai')
    || message.includes('timed out')
    || message.includes('unavailable');
}

export class DefaultQueryService implements QueryService {
  private readonly responseGenerator: TemplateResponseGenerator;
  private readonly hp: QueryHyperParams;

  public constructor(public readonly dependencies: QueryServiceDependencies) {
    this.responseGenerator = dependencies.responseGenerator ?? new TemplateResponseGenerator();
    this.hp = dependencies.hyperParams ?? DEFAULT_HYPER_PARAMS;
  }

  public async query(request: QueryRequest): Promise<QueryResponse> {
    const normalizedText = normalizeQueryText(request.text);
    const matches = await this.dependencies.dictionary.match(normalizedText, 'unknown');
    const expansion = await this.dependencies.expansionPolicy.expandQuery(normalizedText);
    const expandedRequest: QueryRequest = {
      ...request,
      text: expansion.rewrittenQuery,
    };
    const candidates = await this.dependencies.memoryFilter.filter(expandedRequest);
    const initialVector = await this.dependencies.nodeInitializer.initialize({
      query: expandedRequest,
      candidates,
    });
    const ranking = await this.dependencies.ppr.run({
      corpusId: request.corpusId,
      initialVector,
      teleportProbability: this.hp.teleportProbability,
      convergenceEpsilon: 1e-6,
      maxIterations: 100,
      topK: request.topK,
      topM: request.topM,
    }, this.dependencies.projection);

    const isComparison = isComparisonQuery(expandedRequest.text);
    const context = await this.dependencies.contextBuilder.build(expandedRequest, ranking);
    const entities = toEntityHits(matches);

    let responseText: string;
    let llmInputTokens = 0;
    let llmOutputTokens = 0;
    let templateFallbackTriggered = false;
    let scVotes: string[] | undefined;

    try {
      const prompt = isComparison
        ? `You are answering a comparison or yes/no question about two or more entities.

Step-by-step:
1. Identify the entities or subjects being compared
2. Find the relevant attribute or fact for each entity in the context
3. Compare the attributes directly (dates, numbers, categories, or factual properties)
4. Determine the answer

Rules:
- Use ONLY the provided context
- For "which" questions: answer with the entity name only
- For "are both X and Y..." / yes-no questions: answer "yes" or "no"
- For "what do X and Y both..." questions: answer with the shared attribute
- If the context seems insufficient, give your best answer based on available information — NEVER refuse to answer
- Your last line MUST be: FINAL: <your answer>

Question: ${expandedRequest.text}

Context:
${context.promptContext}

Reasoning and answer:`
        : `You are answering a multi-hop question that requires connecting information across multiple passages.

Step-by-step:
1. Identify the first entity or fact mentioned in the question
2. Find information about that entity in the context
3. Follow the chain: use what you learned to find the next piece of information
4. Continue until you reach the final answer
5. Before answering, re-read the question: confirm exactly WHAT is being asked (a person? a place? a title? an event?)

Rules:
- Use ONLY the provided context
- Use the full official name (do not abbreviate)
- Answer exactly what the question asks — not an intermediate entity in the chain
- If the context seems insufficient, give your best answer based on available information — NEVER refuse to answer
- Your last line MUST be: FINAL: <your answer>
- The answer should be a complete name, title, or phrase that precisely matches what is asked

Question: ${expandedRequest.text}

Context:
${context.promptContext}

Reasoning and answer:`;

      // Self-consistency: generate N samples and take majority vote
      const scTemp = this.hp.scTemperature;
      const scN = this.hp.scSamples;

      const samplePromises = [
        this.dependencies.llm.generate({ prompt, temperature: 0.0 }),
      ];
      for (let i = 1; i < scN; i++) {
        samplePromises.push(
          this.dependencies.llm.generate({ prompt, temperature: scTemp }),
        );
      }
      const results = await Promise.all(samplePromises);

      const votes: string[] = [];
      for (const r of results) {
        votes.push(DefaultQueryService.extractFinalAnswer(r.text));
        llmInputTokens += r.usage.inputTokens;
        llmOutputTokens += r.usage.outputTokens;
      }

      scVotes = votes;
      responseText = DefaultQueryService.majorityVote(votes);
    } catch (error) {
      if (!shouldUseTemplateFallback(error)) {
        throw error;
      }
      responseText = this.responseGenerator.generate({
        ...context,
        entities: entities.map((entity) => entity.term),
      });
      templateFallbackTriggered = true;
    }

    return {
      response: responseText,
      citations: toCitations(context),
      entities,
      metrics: {
        dictionaryMatchCount: matches.length,
        expandedTerms: candidates.expandedTerms,
        fallbackTriggered: candidates.fallbackRequired || initialVector.fallbackTriggered || templateFallbackTriggered,
        pprIterations: ranking.iterations,
        pprConverged: ranking.converged,
        citedPassageCount: context.citedPassages.length,
        llmInputTokens,
        llmOutputTokens,
        scVotes,
      },
    };
  }

  /**
   * Normalize an answer for comparison: lowercase, strip articles/punctuation/whitespace.
   */
  private static normalizeForVote(answer: string): string {
    return answer.toLowerCase()
      .replace(/\b(a|an|the)\b/g, ' ')
      .replace(/[^a-z0-9 ]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Self-consistency majority vote: pick the most common normalized answer.
   * 2-1 split → majority wins. 3-way split → first vote (deterministic sample).
   */
  private static majorityVote(votes: readonly string[]): string {
    if (votes.length === 0) return '';
    if (votes.length === 1) return votes[0]!;

    // Count normalized answers
    const counts = new Map<string, { count: number; original: string }>();
    for (const vote of votes) {
      const norm = DefaultQueryService.normalizeForVote(vote);
      const existing = counts.get(norm);
      if (existing) {
        existing.count++;
      } else {
        counts.set(norm, { count: 1, original: vote });
      }
    }

    // Find the answer with the most votes
    let best = { count: 0, original: votes[0]! };
    for (const entry of counts.values()) {
      if (entry.count > best.count) {
        best = entry;
      }
    }

    return best.original;
  }

  private static extractFinalAnswer(llmText: string): string {
    const lines = llmText.trim().split('\n').filter(l => l.trim());
    const finalLine = lines.find(l => /^FINAL:/i.test(l.trim()));
    let answer = finalLine
      ? finalLine.replace(/^FINAL:\s*/i, '').trim()
      : lines[lines.length - 1]?.trim() ?? llmText.trim();
    answer = answer.replace(/^["']|["']$/g, '').trim();
    return answer;
  }
}

export interface ContextBuilderDependencies {
  getPassageByNodeId(nodeId: string): Promise<Passage | null>;
  getFactByNodeId(nodeId: string): Promise<Fact | null>;
}

export class ContextBuilderService implements IContextBuilder {
  public constructor(private readonly dependencies: ContextBuilderDependencies) {}

  public async build(_query: QueryRequest, ranking: PPRResult): Promise<ContextBundle> {
    const citedPassages = (
      await Promise.all(
        ranking.rankedPassages.map((node) => this.dependencies.getPassageByNodeId(node.nodeId)),
      )
    ).filter((passage): passage is Passage => passage !== null);
    const citedFacts = (
      await Promise.all(
        ranking.rankedEntities.map((node) => this.dependencies.getFactByNodeId(node.nodeId)),
      )
    ).filter((fact): fact is Fact => fact !== null);

    const promptContext = [
      ...citedPassages.map((passage) => `Passage: ${passage.text}`),
      ...citedFacts.map((fact) => `Fact: ${fact.headEntity} ${fact.relation} ${fact.tailEntity}`),
    ].join('\n');

    return {
      promptContext,
      citedPassages,
      citedFacts,
      confidence: ranking.rankedPassages[0]?.score ?? 0,
    };
  }
}
