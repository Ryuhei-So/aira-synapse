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

  public constructor(public readonly dependencies: QueryServiceDependencies) {
    this.responseGenerator = dependencies.responseGenerator ?? new TemplateResponseGenerator();
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
      teleportProbability: 0.5,
      convergenceEpsilon: 1e-6,
      maxIterations: 100,
      topK: request.topK,
      topM: request.topM,
    }, this.dependencies.projection);
    const context = await this.dependencies.contextBuilder.build(expandedRequest, ranking);
    const entities = toEntityHits(matches);

    let responseText: string;
    let llmInputTokens = 0;
    let llmOutputTokens = 0;
    let templateFallbackTriggered = false;

    try {
      const llm = await this.dependencies.llm.generate({
        prompt: `${expandedRequest.text}\n\n${context.promptContext}`,
        temperature: 0.1,
      });
      responseText = llm.text;
      llmInputTokens = llm.usage.inputTokens;
      llmOutputTokens = llm.usage.outputTokens;
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
      },
    };
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
