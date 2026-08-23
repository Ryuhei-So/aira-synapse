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
import { DEFAULT_HUB_DEGREE_THRESHOLD } from '../../domain/retrieval/ppr.js';
import type { Fact } from '../../domain/memory/fact.js';
import type { Passage } from '../../domain/memory/passage.js';
import type { QueryFeatureFlags } from '../../domain/config/featureFlags.js';
import type { IMultiHopReasoner } from '../../domain/retrieval/multiHop.js';
import type { PreparedQuery, RetrievedQueryContext, RankedPassage, RankedFact } from '../../domain/retrieval/federation.js';
import type { QuestionType, MultiHopFallbackReason } from '../../domain/retrieval/multiHop.js';
import type { FederatedDbMetric } from './federationTypes.js';
import { DEFAULT_QUERY_FLAGS } from '../../domain/config/featureFlags.js';
import type { ThesaurusExpansionPolicy } from './ThesaurusExpansionPolicy.js';
import { TemplateResponseGenerator } from './TemplateResponseGenerator.js';
import { isComparisonQuery } from './comparisonDetector.js';
import { extractFinalAnswer } from './query-utils.js';
import type { SubQueryDecomposer } from './SubQueryDecomposer.js';
import type { ComparisonVerifier } from './ComparisonVerifier.js';
import { DictionaryContextEnricher } from './DictionaryContextEnricher.js';
import {
  associateV15RankedFacts,
  associateV15RankedPassages,
  buildV15RetrievalRequestPlan,
  unsupportedV15Features,
  type V15RetrievalRequestPlan,
} from '../../domain/retrieval/v15Plan.js';

export interface CitationDto {
  readonly passageId: string;
  readonly title: string;
  readonly sourceUrl: string;
  readonly snippet: string;
  readonly dbId?: string;
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
  // Multi-hop reasoning additions (REQ-MH-009)
  readonly multiHopEnabled?: boolean;
  readonly questionType?: QuestionType;
  readonly hop1SubQuestion?: string;
  readonly hop2SubQuestion?: string;
  readonly hop1Answer?: string;
  readonly hop2Answer?: string;
  readonly hop1PassageIds?: readonly string[];
  readonly hop2PassageIds?: readonly string[];
  readonly multiHopFallbackReason?: MultiHopFallbackReason;
  readonly multiHopLatencyMs?: number;
  // Federation additions (DES-FED-007)
  readonly federationEnabled?: boolean;
  readonly federatedDbCount?: number;
  readonly federatedSuccessCount?: number;
  readonly federatedFailureCount?: number;
  readonly perDbMetrics?: readonly FederatedDbMetric[];
  readonly rrfMergedCount?: number;
  readonly rrfDeduplicatedCount?: number;
}

export interface QueryResponse {
  readonly response: string;
  readonly citations: readonly CitationDto[];
  readonly entities: readonly EntityHit[];
  readonly metrics: QueryMetrics;
  readonly warnings?: readonly string[];
}

export interface QueryService {
  query(request: QueryRequest): Promise<QueryResponse>;
  retrieve(request: QueryRequest, precomputedVector?: readonly number[]): Promise<RetrievedQueryContext>;
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
  hubDegreeThreshold: DEFAULT_HUB_DEGREE_THRESHOLD,
  reasoningEffort: 'high',
  verbosity: 'low',
};

/** Existing QueryService policy authority for the legacy PPR call. */
export const DEFAULT_PPR_CONVERGENCE_EPSILON = 1e-6;
export const DEFAULT_PPR_MAX_ITERATIONS = 100;

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
  readonly multiHopReasoner?: IMultiHopReasoner;
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

function toCitationsFromPassages(passages: readonly RankedPassage[]): readonly CitationDto[] {
  return passages.map((rp) => ({
    passageId: rp.passage.passageId,
    title: rp.passage.metadata.title,
    sourceUrl: rp.passage.metadata.sourceUrl,
    snippet: rp.passage.text,
    dbId: rp.dbId,
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

  /** Preprocess: normalize, dictionary match, thesaurus expand, comparison detect, dict enrich. */
  public async prepare(request: QueryRequest): Promise<PreparedQuery> {
    const normalizedText = normalizeQueryText(request.text);
    const matches = await this.dependencies.dictionary.match(normalizedText, 'unknown');

    let expansion: { expandedTerms: readonly string[]; rewrittenQuery: string; originalQuery: string };
    if (this.flags.enableThesaurusExpansion) {
      expansion = await this.dependencies.expansionPolicy.expandQuery(normalizedText);
    } else {
      expansion = { expandedTerms: [], rewrittenQuery: normalizedText, originalQuery: normalizedText };
    }

    const expandedRequest: QueryRequest = { ...request, text: expansion.rewrittenQuery };
    const isComparison = isComparisonQuery(expandedRequest.text);

    let dictionaryHints = '';
    if (this.flags.enableDictionaryInjection) {
      const enricher = new DictionaryContextEnricher(this.dependencies.dictionary);
      const hints = await enricher.getHints(normalizedText);
      dictionaryHints = enricher.formatHints(hints);
    }

    return {
      normalizedText,
      expandedRequest,
      entityHits: toEntityHits(matches).map((e) => ({ term: e.term, matchedText: e.matchedText, boostFactor: e.boostFactor })),
      dictionaryHints,
      isComparison,
    };
  }

  /** Build the bounded static policy before any candidate or snapshot access. */
  public createBoundedRetrievalRequestPlan(
    prepared: PreparedQuery,
    queryVector: readonly number[],
  ): V15RetrievalRequestPlan {
    return buildV15RetrievalRequestPlan(prepared.expandedRequest, queryVector, {
      comparisonMode: prepared.isComparison,
      featureFlags: this.flags,
      teleportProbability: this.hp.teleportProbability,
      convergenceEpsilon: DEFAULT_PPR_CONVERGENCE_EPSILON,
      maxIterations: DEFAULT_PPR_MAX_ITERATIONS,
      hubDegreeThreshold: this.hp.hubDegreeThreshold,
    });
  }

  /** Execute retrieval using pre-processed query. No normalization/expansion. */
  public async retrievePrepared(
    prepared: PreparedQuery,
    precomputedVector?: readonly number[],
  ): Promise<RetrievedQueryContext> {
    const startTime = Date.now();
    const { expandedRequest } = prepared;

    const candidates = await this.dependencies.memoryFilter.filter(expandedRequest, precomputedVector);
    const initRequest = { query: expandedRequest, candidates };
    let initialVector = await this.dependencies.nodeInitializer.initialize(initRequest);

    if (this.flags.enableSubQueryDecomposition && this.dependencies.subQueryDecomposer) {
      const subResult = await this.dependencies.subQueryDecomposer.decompose(initRequest, initialVector);
      initialVector = subResult.mergedVector;
    }

    const ranking = await this.dependencies.ppr.run({
      corpusId: expandedRequest.corpusId,
      initialVector,
      teleportProbability: this.hp.teleportProbability,
      convergenceEpsilon: DEFAULT_PPR_CONVERGENCE_EPSILON,
      maxIterations: DEFAULT_PPR_MAX_ITERATIONS,
      hubDegreeThreshold: this.hp.hubDegreeThreshold,
      topK: expandedRequest.topK,
      topM: expandedRequest.topM,
    }, this.dependencies.projection);

    const context = await this.dependencies.contextBuilder.build(expandedRequest, ranking);

    const retrievalPlan: V15RetrievalRequestPlan | undefined = candidates.queryVector.length > 0
      && unsupportedV15Features(this.flags).length === 0
      ? this.createBoundedRetrievalRequestPlan(prepared, candidates.queryVector)
      : undefined;

    // Build RankedPassage[] and RankedFact[] from PPR results
    const passages: import('../../domain/retrieval/federation.js').RankedPassage[] =
      associateV15RankedPassages(ranking.rankedPassages, context.citedPassages)
        .map(({ item: passage, node, rank }) => ({ passage, score: node.score, rank }));

    const facts: import('../../domain/retrieval/federation.js').RankedFact[] =
      associateV15RankedFacts(ranking.rankedEntities, context.citedFacts)
        .map(({ item: fact, node, rank }) => ({ fact, score: node.score, rank }));

    return {
      passages,
      facts,
      pprResult: ranking,
      contextBundle: context,
      normalizedText: prepared.normalizedText,
      expandedRequest,
      entityHits: prepared.entityHits,
      dictionaryHints: prepared.dictionaryHints,
      isComparison: prepared.isComparison,
      queryVector: [...candidates.queryVector],
      retrievalPlan,
      metrics: {
        dictionaryMatchCount: prepared.entityHits.length,
        expandedTerms: candidates.expandedTerms,
        fallbackTriggered: candidates.fallbackRequired || initialVector.fallbackTriggered,
        pprIterations: ranking.iterations,
        pprConverged: ranking.converged,
        citedPassageCount: context.citedPassages.length,
        latencyMs: Date.now() - startTime,
      },
    };
  }

  /** Full retrieve: prepare + retrievePrepared. */
  public async retrieve(
    request: QueryRequest,
    precomputedVector?: readonly number[],
  ): Promise<RetrievedQueryContext> {
    const prepared = await this.prepare(request);
    return this.retrievePrepared(prepared, precomputedVector);
  }

  /** Generate answer from retrieved context. */
  public async answer(_request: QueryRequest, ctx: RetrievedQueryContext): Promise<QueryResponse> {
    const startTime = Date.now();
    const enrichedContext = ctx.dictionaryHints + ctx.contextBundle.promptContext;
    const entities: readonly EntityHit[] = ctx.entityHits.map((e) => ({
      term: e.term, matchedText: e.matchedText, boostFactor: e.boostFactor,
    }));

    let responseText: string;
    let llmInputTokens = 0;
    let llmOutputTokens = 0;
    let templateFallbackTriggered = false;
    let scVotes: string[] | undefined;
    let comparisonVerified: boolean | undefined;

    // Multi-hop reasoning metrics
    let multiHopEnabled: boolean | undefined;
    let mhQuestionType: QuestionType | undefined;
    let mhHop1SubQuestion: string | undefined;
    let mhHop2SubQuestion: string | undefined;
    let mhHop1Answer: string | undefined;
    let mhHop2Answer: string | undefined;
    let mhHop1PassageIds: readonly string[] | undefined;
    let mhHop2PassageIds: readonly string[] | undefined;
    let mhFallbackReason: MultiHopFallbackReason | undefined;
    let mhLatencyMs: number | undefined;

    let multiHopHint = '';
    if (this.flags.enableMultiHopReasoning && this.dependencies.multiHopReasoner && !ctx.isComparison) {
      multiHopEnabled = true;
      const passagesForMH = ctx.contextBundle.citedPassages.map((p) => ({
        id: p.passageId, text: p.text,
      }));

      const mhResult = await this.dependencies.multiHopReasoner.reason(
        ctx.expandedRequest.text, passagesForMH,
      );

      mhQuestionType = mhResult.questionType;
      mhLatencyMs = mhResult.latencyMs;
      llmInputTokens += mhResult.usage.inputTokens;
      llmOutputTokens += mhResult.usage.outputTokens;

      if (mhResult.hop1) { mhHop1Answer = mhResult.hop1.answer; mhHop1PassageIds = mhResult.hop1.passageIds; }
      if (mhResult.hop2) { mhHop2Answer = mhResult.hop2.answer; mhHop2PassageIds = mhResult.hop2.passageIds; }
      if (mhResult.fallbackReason) { mhFallbackReason = mhResult.fallbackReason; }

      if (!mhResult.fellBack && mhResult.answer) {
        multiHopHint = `\n\n[Chain-of-thought hint: intermediate reasoning suggests "${mhResult.hop1?.answer ?? ''}" leads to "${mhResult.answer}". Verify against context before using.]`;
      }
    }

    try {
      const prompt = ctx.isComparison
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

Question: ${ctx.expandedRequest.text}

Context:
${enrichedContext}${multiHopHint}

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

Question: ${ctx.expandedRequest.text}

Context:
${enrichedContext}${multiHopHint}

Reasoning and answer:`;

      const scTemp = this.hp.scTemperature;
      const scN = this.hp.scSamples;

      const samplePromises = [
        this.dependencies.llm.generate({
          prompt, temperature: 0.0,
          reasoningEffort: this.hp.reasoningEffort, verbosity: this.hp.verbosity,
        }),
      ];
      for (let i = 1; i < scN; i++) {
        samplePromises.push(
          this.dependencies.llm.generate({
            prompt, temperature: scTemp,
            reasoningEffort: this.hp.reasoningEffort, verbosity: this.hp.verbosity,
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

      if (ctx.isComparison && this.flags.enableComparisonVerification && this.dependencies.comparisonVerifier) {
        const rawResponse = results[0]?.text ?? '';
        const verifyResult = await this.dependencies.comparisonVerifier.verify(
          responseText, rawResponse, ctx.expandedRequest.text, ctx.contextBundle.promptContext,
          { reasoningEffort: this.hp.reasoningEffort, verbosity: this.hp.verbosity },
        );
        responseText = verifyResult.response;
        comparisonVerified = verifyResult.verified;
      }
    } catch (error) {
      if (!shouldUseTemplateFallback(error)) { throw error; }
      responseText = this.responseGenerator.generate({
        ...ctx.contextBundle,
        entities: entities.map((entity) => entity.term),
      });
      templateFallbackTriggered = true;
    }

    const totalLatencyMs = Date.now() - startTime;
    const hasDbId = ctx.passages.some((rp) => rp.dbId !== undefined);

    return {
      response: responseText,
      citations: hasDbId ? toCitationsFromPassages(ctx.passages) : toCitations(ctx.contextBundle),
      entities,
      metrics: {
        dictionaryMatchCount: ctx.metrics.dictionaryMatchCount,
        expandedTerms: ctx.metrics.expandedTerms,
        fallbackTriggered: ctx.metrics.fallbackTriggered || templateFallbackTriggered,
        pprIterations: ctx.metrics.pprIterations,
        pprConverged: ctx.metrics.pprConverged,
        citedPassageCount: ctx.metrics.citedPassageCount,
        llmInputTokens,
        llmOutputTokens,
        scVotes,
        dictionaryHintCount: ctx.dictionaryHints.length > 0 ? undefined : undefined, // preserved from retrieval
        aliasHintCount: ctx.contextBundle.metadata?.aliasHintCount,
        comparisonVerified,
        totalLatencyMs,
        multiHopEnabled,
        questionType: mhQuestionType,
        hop1SubQuestion: mhHop1SubQuestion,
        hop2SubQuestion: mhHop2SubQuestion,
        hop1Answer: mhHop1Answer,
        hop2Answer: mhHop2Answer,
        hop1PassageIds: mhHop1PassageIds,
        hop2PassageIds: mhHop2PassageIds,
        multiHopFallbackReason: mhFallbackReason,
        multiHopLatencyMs: mhLatencyMs,
      },
    };
  }

  /** Full query pipeline: prepare → retrieve → answer. */
  public async query(request: QueryRequest): Promise<QueryResponse> {
    const ctx = await this.retrieve(request);
    return this.answer(request, ctx);
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
