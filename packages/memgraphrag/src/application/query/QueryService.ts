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
import type { QueryFeatureFlags } from '../../domain/config/featureFlags.js';
import { DEFAULT_QUERY_FLAGS } from '../../domain/config/featureFlags.js';
import { ThesaurusExpansionPolicy } from './ThesaurusExpansionPolicy.js';
import { TemplateResponseGenerator } from './TemplateResponseGenerator.js';
import { isComparisonQuery, analyzeComparisonQuery } from './comparisonDetector.js';
import type { ComparisonType } from './comparisonDetector.js';
import { extractFinalAnswer } from './query-utils.js';
import type { SubQueryDecomposer } from './SubQueryDecomposer.js';
import type { ComparisonVerifier } from './ComparisonVerifier.js';
import type { IQueryRewriter } from '../../domain/retrieval/queryRewriter.js';
import { DictionaryContextEnricher } from './DictionaryContextEnricher.js';
import { NORMALIZATION_INSTRUCTIONS } from './prompts/normalizationInstructions.js';
import { buildYesNoComparisonPrompt } from './prompts/comparisonYesNoPrompt.js';

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
  // v0.3.0 additions
  readonly dictionaryHintCount?: number;
  readonly aliasHintCount?: number;
  readonly thesaurusExpandedTerms?: readonly string[];
  readonly subQueryDecomposed?: boolean;
  readonly hop1FactCount?: number;
  readonly hop2FactCount?: number;
  readonly comparisonVerified?: boolean;
  readonly totalLatencyMs?: number;
  // Phase 2a: query rewriting metrics
  readonly queryRewriteUsed?: boolean;
  readonly queryRewriteSubQueryCount?: number;
  readonly queryRewriteFallback?: boolean;
  readonly queryRewriteFallbackReason?: string;
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
  readonly scTemperature: number;         // Self-consistency temperature (default: 0.0)
  readonly scSamples: number;             // Number of SC samples (default: 1=disabled)
  readonly hubDegreeThreshold: number;    // PPR hub damping threshold (default: 50)
  readonly reasoningEffort: 'low' | 'medium' | 'high';  // LLM reasoning depth for answer step
  readonly verbosity: 'low' | 'medium' | 'high';        // LLM output verbosity for answer step
}

export const DEFAULT_HYPER_PARAMS: QueryHyperParams = {
  teleportProbability: 0.5,
  scTemperature: 0.0,
  scSamples: 1,
  hubDegreeThreshold: 50,
  reasoningEffort: 'high',
  verbosity: 'low',
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
  readonly featureFlags?: QueryFeatureFlags;
  readonly subQueryDecomposer?: SubQueryDecomposer;
  readonly comparisonVerifier?: ComparisonVerifier;
  readonly queryRewriter?: IQueryRewriter;
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
  private readonly flags: QueryFeatureFlags;

  public constructor(public readonly dependencies: QueryServiceDependencies) {
    this.responseGenerator = dependencies.responseGenerator ?? new TemplateResponseGenerator();
    this.hp = dependencies.hyperParams ?? DEFAULT_HYPER_PARAMS;
    this.flags = dependencies.featureFlags ?? DEFAULT_QUERY_FLAGS;
  }

  public async query(request: QueryRequest): Promise<QueryResponse> {
    const startTime = Date.now();
    const normalizedText = normalizeQueryText(request.text);
    const matches = await this.dependencies.dictionary.match(normalizedText, 'unknown');

    // Thesaurus expansion (controlled by flag)
    let expansion: { expandedTerms: readonly string[]; rewrittenQuery: string; originalQuery: string };
    if (this.flags.enableThesaurusExpansion) {
      expansion = await this.dependencies.expansionPolicy.expandQuery(normalizedText);
    } else {
      expansion = { expandedTerms: [], rewrittenQuery: normalizedText, originalQuery: normalizedText };
    }

    const expandedRequest: QueryRequest = {
      ...request,
      text: expansion.rewrittenQuery,
    };
    const candidates = await this.dependencies.memoryFilter.filter(expandedRequest);
    const initRequest = { query: expandedRequest, candidates };
    let initialVector = await this.dependencies.nodeInitializer.initialize(initRequest);

    const isComparison = isComparisonQuery(expandedRequest.text);
    // Phase 2: Fine-grained comparison analysis (DES-MG4-003)
    const compAnalysis = this.flags.enableComparisonReasoning
      ? analyzeComparisonQuery(expandedRequest.text)
      : { type: 'none' as ComparisonType, entities: [] as readonly string[], confidence: 0 };

    const entities = toEntityHits(matches);

    // --- Mutual exclusion: enableQueryRewriting supersedes enableSubQueryDecomposition ---
    const effectiveSubQueryDecomposition = this.flags.enableSubQueryDecomposition
      && !this.flags.enableQueryRewriting;
    if (this.flags.enableSubQueryDecomposition && this.flags.enableQueryRewriting) {
      // eslint-disable-next-line no-console
      console.warn('[QueryService] Both enableQueryRewriting and enableSubQueryDecomposition are ON. Disabling old SubQueryDecomposer.');
    }

    // Phase 2a: Query rewriting for bridge questions (DES-MG4-005)
    let queryRewriteUsed = false;
    let queryRewriteSubQueryCount = 0;
    let queryRewriteFallback: boolean | undefined;
    let queryRewriteFallbackReason: string | undefined;

    if (this.flags.enableQueryRewriting && this.dependencies.queryRewriter && !isComparison) {
      const rewriteResult = await this.dependencies.queryRewriter.rewrite({ query: expandedRequest });
      queryRewriteUsed = true;
      queryRewriteSubQueryCount = rewriteResult.subQueries.length;
      queryRewriteFallback = rewriteResult.fallback;
      queryRewriteFallbackReason = rewriteResult.fallbackReason;

      if (rewriteResult.decomposed && !rewriteResult.fallback) {
        // Use merged ranking from rewriter — skip standard PPR
        const ranking = rewriteResult.mergedRanking;
        const context = await this.dependencies.contextBuilder.build(expandedRequest, ranking);
        return this.buildResponse(expandedRequest, ranking, context, matches, expansion, entities, startTime, {
          queryRewriteUsed,
          queryRewriteSubQueryCount,
          queryRewriteFallback,
          queryRewriteFallbackReason,
          compAnalysis,
          isComparison,
        });
      }
      // Fallback: continue with standard pipeline below
    }

    // Sub-query decomposition for bridge questions (legacy, deprecated)
    let subQueryDecomposed = false;
    let hop1FactCount = 0;
    let hop2FactCount = 0;
    if (effectiveSubQueryDecomposition && this.dependencies.subQueryDecomposer) {
      const subResult = await this.dependencies.subQueryDecomposer.decompose(initRequest, initialVector);
      initialVector = subResult.mergedVector;
      subQueryDecomposed = subResult.decomposed;
      hop1FactCount = subResult.hop1FactCount;
      hop2FactCount = subResult.hop2FactCount;
    }

    const ranking = await this.dependencies.ppr.run({
      corpusId: request.corpusId,
      initialVector,
      teleportProbability: this.hp.teleportProbability,
      convergenceEpsilon: 1e-6,
      maxIterations: 100,
      topK: request.topK,
      topM: request.topM,
    }, this.dependencies.projection);

    const context = await this.dependencies.contextBuilder.build(expandedRequest, ranking);

    // Dictionary context enrichment (v0.3.0 revised: enrich context, not teleport vector)
    let dictionaryHints = '';
    let dictionaryHintCount = 0;
    if (this.flags.enableDictionaryInjection) {
      const enricher = new DictionaryContextEnricher(this.dependencies.dictionary);
      const hints = await enricher.getHints(normalizedText);
      dictionaryHints = enricher.formatHints(hints);
      dictionaryHintCount = hints.length;
    }

    const enrichedContext = dictionaryHints + context.promptContext;

    let responseText: string;
    let llmInputTokens = 0;
    let llmOutputTokens = 0;
    let templateFallbackTriggered = false;
    let scVotes: string[] | undefined;
    let comparisonVerified: boolean | undefined;

    try {
      // Phase 2: Answer normalization (DES-MG4-004)
      const normInstructions = this.flags.enableAnswerNormalization
        ? NORMALIZATION_INSTRUCTIONS
        : '';

      // Phase 2: Yes/No comparison reasoning (DES-MG4-003)
      const useYesNoPrompt = this.flags.enableComparisonReasoning && compAnalysis.type === 'yesno';

      const prompt = useYesNoPrompt
        ? buildYesNoComparisonPrompt(expandedRequest.text, compAnalysis.entities, enrichedContext)
        : isComparison
        ? `You are answering a comparison or yes/no question about two or more entities.

Step-by-step:
1. Identify the entities or subjects being compared
2. Find the relevant attribute or fact for each entity in the context
3. Compare the attributes directly (dates, numbers, categories, or factual properties)
4. Determine the answer
${normInstructions}
Rules:
- Use ONLY the provided context
- For "which" questions: answer with the entity name only
- For "are both X and Y..." / yes-no questions: answer "yes" or "no"
- For "what do X and Y both..." questions: answer with the shared attribute
- If the context seems insufficient, give your best answer based on available information — NEVER refuse to answer
- Your last line MUST be: FINAL: <your answer>

Question: ${expandedRequest.text}

Context:
${enrichedContext}

Reasoning and answer:`
        : `You are answering a multi-hop question that requires connecting information across multiple passages.

Step-by-step:
1. Identify the first entity or fact mentioned in the question
2. Find information about that entity in the context
3. Follow the chain: use what you learned to find the next piece of information
4. Continue until you reach the final answer
5. Before answering, re-read the question: confirm exactly WHAT is being asked (a person? a place? a title? an event?)
${normInstructions}
Rules:
- Use ONLY the provided context
- Use the full official name (do not abbreviate)
- Answer exactly what the question asks — not an intermediate entity in the chain
- If the context seems insufficient, give your best answer based on available information — NEVER refuse to answer
- Your last line MUST be: FINAL: <your answer>
- The answer should be a complete name, title, or phrase that precisely matches what is asked

Question: ${expandedRequest.text}

Context:
${enrichedContext}

Reasoning and answer:`;

      // Self-consistency: generate N samples and take majority vote
      const scTemp = this.hp.scTemperature;
      const scN = this.hp.scSamples;

      const samplePromises = [
        this.dependencies.llm.generate({
          prompt,
          temperature: 0.0,
          reasoningEffort: this.hp.reasoningEffort,
          verbosity: this.hp.verbosity,
        }),
      ];
      for (let i = 1; i < scN; i++) {
        samplePromises.push(
          this.dependencies.llm.generate({
            prompt,
            temperature: scTemp,
            reasoningEffort: this.hp.reasoningEffort,
            verbosity: this.hp.verbosity,
          }),
        );
      }
      const results = await Promise.all(samplePromises);

      const votes: string[] = [];
      for (const r of results) {
        votes.push(extractFinalAnswer(r.text));
        llmInputTokens += r.usage.inputTokens;
        llmOutputTokens += r.usage.outputTokens;
      }

      scVotes = votes;
      responseText = DefaultQueryService.majorityVote(votes);

      // Comparison verification
      if (isComparison && this.flags.enableComparisonVerification && this.dependencies.comparisonVerifier) {
        const rawResponse = results[0]?.text ?? '';
        const verifyResult = await this.dependencies.comparisonVerifier.verify(
          responseText, rawResponse, expandedRequest.text, context.promptContext,
          { reasoningEffort: this.hp.reasoningEffort, verbosity: this.hp.verbosity },
        );
        responseText = verifyResult.response;
        comparisonVerified = verifyResult.verified;
      }
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

    const totalLatencyMs = Date.now() - startTime;

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
        dictionaryHintCount: dictionaryHintCount > 0 ? dictionaryHintCount : undefined,
        aliasHintCount: context.metadata?.aliasHintCount,
        thesaurusExpandedTerms: expansion.expandedTerms.length > 0 ? expansion.expandedTerms : undefined,
        subQueryDecomposed: subQueryDecomposed || undefined,
        hop1FactCount: hop1FactCount > 0 ? hop1FactCount : undefined,
        hop2FactCount: hop2FactCount > 0 ? hop2FactCount : undefined,
        comparisonVerified: comparisonVerified,
        totalLatencyMs,
        queryRewriteUsed: queryRewriteUsed || undefined,
        queryRewriteSubQueryCount: queryRewriteSubQueryCount > 0 ? queryRewriteSubQueryCount : undefined,
        queryRewriteFallback,
        queryRewriteFallbackReason,
      },
    };
  }

  /**
   * Build final response from ranking + context, shared by both standard and rewrite paths.
   * Used when the query rewriter successfully decomposes and merges a result.
   */
  private async buildResponse(
    expandedRequest: QueryRequest,
    ranking: PPRResult,
    context: ContextBundle,
    matches: readonly DictionaryMatch[],
    expansion: { expandedTerms: readonly string[]; rewrittenQuery: string; originalQuery: string },
    entities: readonly EntityHit[],
    startTime: number,
    extra: {
      queryRewriteUsed?: boolean;
      queryRewriteSubQueryCount?: number;
      queryRewriteFallback?: boolean;
      queryRewriteFallbackReason?: string;
      compAnalysis: { type: ComparisonType; entities: readonly string[]; confidence: number };
      isComparison: boolean;
    },
  ): Promise<QueryResponse> {
    const normalizedText = expandedRequest.text;

    // Dictionary context enrichment
    let dictionaryHints = '';
    let dictionaryHintCount = 0;
    if (this.flags.enableDictionaryInjection) {
      const enricher = new DictionaryContextEnricher(this.dependencies.dictionary);
      const hints = await enricher.getHints(normalizedText);
      dictionaryHints = enricher.formatHints(hints);
      dictionaryHintCount = hints.length;
    }
    const enrichedContext = dictionaryHints + context.promptContext;

    // Answer normalization
    const normInstructions = this.flags.enableAnswerNormalization
      ? NORMALIZATION_INSTRUCTIONS
      : '';

    // Yes/No comparison reasoning
    const useYesNoPrompt = this.flags.enableComparisonReasoning && extra.compAnalysis.type === 'yesno';

    const prompt = useYesNoPrompt
      ? buildYesNoComparisonPrompt(expandedRequest.text, extra.compAnalysis.entities, enrichedContext)
      : extra.isComparison
      ? `You are answering a comparison or yes/no question about two or more entities.

Step-by-step:
1. Identify the entities or subjects being compared
2. Find the relevant attribute or fact for each entity in the context
3. Compare the attributes directly (dates, numbers, categories, or factual properties)
4. Determine the answer
${normInstructions}
Rules:
- Use ONLY the provided context
- For "which" questions: answer with the entity name only
- For "are both X and Y..." / yes-no questions: answer "yes" or "no"
- For "what do X and Y both..." questions: answer with the shared attribute
- If the context seems insufficient, give your best answer based on available information — NEVER refuse to answer
- Your last line MUST be: FINAL: <your answer>

Question: ${expandedRequest.text}

Context:
${enrichedContext}

Reasoning and answer:`
      : `You are answering a multi-hop question that requires connecting information across multiple passages.

Step-by-step:
1. Identify the first entity or fact mentioned in the question
2. Find information about that entity in the context
3. Follow the chain: use what you learned to find the next piece of information
4. Continue until you reach the final answer
5. Before answering, re-read the question: confirm exactly WHAT is being asked (a person? a place? a title? an event?)
${normInstructions}
Rules:
- Use ONLY the provided context
- Use the full official name (do not abbreviate)
- Answer exactly what the question asks — not an intermediate entity in the chain
- If the context seems insufficient, give your best answer based on available information — NEVER refuse to answer
- Your last line MUST be: FINAL: <your answer>
- The answer should be a complete name, title, or phrase that precisely matches what is asked

Question: ${expandedRequest.text}

Context:
${enrichedContext}

Reasoning and answer:`;

    let responseText: string;
    let llmInputTokens = 0;
    let llmOutputTokens = 0;
    let templateFallbackTriggered = false;
    let comparisonVerified: boolean | undefined;

    try {
      const result = await this.dependencies.llm.generate({
        prompt,
        temperature: 0.0,
        reasoningEffort: this.hp.reasoningEffort,
        verbosity: this.hp.verbosity,
      });
      responseText = extractFinalAnswer(result.text);
      llmInputTokens = result.usage.inputTokens;
      llmOutputTokens = result.usage.outputTokens;

      // Comparison verification
      if (extra.isComparison && this.flags.enableComparisonVerification && this.dependencies.comparisonVerifier) {
        const verifyResult = await this.dependencies.comparisonVerifier.verify(
          responseText, result.text, expandedRequest.text, context.promptContext,
          { reasoningEffort: this.hp.reasoningEffort, verbosity: this.hp.verbosity },
        );
        responseText = verifyResult.response;
        comparisonVerified = verifyResult.verified;
      }
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

    const totalLatencyMs = Date.now() - startTime;

    return {
      response: responseText,
      citations: toCitations(context),
      entities,
      metrics: {
        dictionaryMatchCount: matches.length,
        expandedTerms: [],
        fallbackTriggered: templateFallbackTriggered,
        pprIterations: ranking.iterations,
        pprConverged: ranking.converged,
        citedPassageCount: context.citedPassages.length,
        llmInputTokens,
        llmOutputTokens,
        dictionaryHintCount: dictionaryHintCount > 0 ? dictionaryHintCount : undefined,
        thesaurusExpandedTerms: expansion.expandedTerms.length > 0 ? expansion.expandedTerms : undefined,
        comparisonVerified,
        totalLatencyMs,
        queryRewriteUsed: extra.queryRewriteUsed || undefined,
        queryRewriteSubQueryCount: extra.queryRewriteSubQueryCount && extra.queryRewriteSubQueryCount > 0 ? extra.queryRewriteSubQueryCount : undefined,
        queryRewriteFallback: extra.queryRewriteFallback,
        queryRewriteFallbackReason: extra.queryRewriteFallbackReason,
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
