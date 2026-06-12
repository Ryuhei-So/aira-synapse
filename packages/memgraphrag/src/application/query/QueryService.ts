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
import type { IMemoryStore } from '../../domain/storage/index.js';
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
  readonly hopTriggered?: boolean;
  readonly hopEntity?: string;
  readonly answerReplaced?: boolean;
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
  readonly memoryStore?: IMemoryStore;
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

    const isComparison = isComparisonQuery(expandedRequest.text);
    const context = await this.dependencies.contextBuilder.build(expandedRequest, ranking);
    const entities = toEntityHits(matches);

    let responseText: string;
    let llmInputTokens = 0;
    let llmOutputTokens = 0;
    let templateFallbackTriggered = false;
    let hopTriggered = false;
    let hopEntity: string | undefined;
    let answerReplaced = false;

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

      let llmResult = await this.dependencies.llm.generate({
        prompt,
        temperature: 0.0,
      });
      responseText = DefaultQueryService.extractFinalAnswer(llmResult.text);
      llmInputTokens = llmResult.usage.inputTokens;
      llmOutputTokens = llmResult.usage.outputTokens;

      // LLM-guided graph traversal with groundedness gate (bridge queries only)
      if (!isComparison && this.dependencies.memoryStore) {
        const firstAnswer = responseText;
        const isGrounded = DefaultQueryService.isAnswerGrounded(firstAnswer, context);

        if (!isGrounded) {
          hopTriggered = true;
          const hopResult = await this.tryGraphHop(
            request.corpusId,
            expandedRequest.text,
            context,
            llmResult.text,
          );

          if (hopResult.passages.length > 0) {
            hopEntity = hopResult.entity;
            const citedIds = new Set(context.citedPassages.map(p => p.passageId));
            const newPassages = hopResult.passages.filter(p => !citedIds.has(p.passageId));

            if (newPassages.length > 0) {
              const hopSection = newPassages
                .slice(0, 3)
                .map(p => `[${p.metadata.documentId}] ${p.text}`)
                .join('\n\n');
              const expandedPrompt = `You are answering a multi-hop question that requires connecting information across multiple passages.

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

## Additional Passages (follow-up retrieval)

${hopSection}

Reasoning and answer:`;

              const hopLlmResult = await this.dependencies.llm.generate({
                prompt: expandedPrompt,
                temperature: 0.0,
              });
              const hopAnswer = DefaultQueryService.extractFinalAnswer(hopLlmResult.text);
              llmInputTokens += hopLlmResult.usage.inputTokens;
              llmOutputTokens += hopLlmResult.usage.outputTokens;

              // Replacement policy: only replace if new answer is grounded in expanded context
              const expandedPassageTexts = [
                ...context.citedPassages.map(p => p.text),
                ...newPassages.map(p => p.text),
              ];
              const hopGrounded = DefaultQueryService.isTextInPassages(hopAnswer, expandedPassageTexts);
              if (hopGrounded) {
                responseText = hopAnswer;
                answerReplaced = true;
              }
              // else: keep firstAnswer — it was the best we had
            }
          }
        }
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
        hopTriggered: hopTriggered || undefined,
        hopEntity,
        answerReplaced: answerReplaced || undefined,
      },
    };
  }

  /**
   * Check if an answer string appears in any cited passage text.
   * Used as the groundedness gate — if the answer isn't grounded in context,
   * it likely needs additional retrieval.
   */
  private static isAnswerGrounded(answer: string, context: ContextBundle): boolean {
    const passageTexts = context.citedPassages.map(p => p.text);
    return DefaultQueryService.isTextInPassages(answer, passageTexts);
  }

  /**
   * Check if a text string (typically an answer) appears in any of the given passage texts.
   * Uses case-insensitive word-boundary matching.
   */
  private static isTextInPassages(text: string, passageTexts: readonly string[]): boolean {
    if (!text || text.length < 2) return false;
    const textLower = text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    if (textLower.length < 2) return false;
    for (const pt of passageTexts) {
      const ptLower = pt.toLowerCase();
      if (ptLower.includes(textLower)) return true;
    }
    // Token-level check: if >60% of answer tokens appear in concatenated passages
    const tokens = textLower.split(' ').filter(t => t.length > 2);
    if (tokens.length >= 2) {
      const allText = passageTexts.join(' ').toLowerCase();
      const matched = tokens.filter(t => allText.includes(t)).length;
      if (matched >= tokens.length * 0.6) return true;
    }
    return false;
  }

  /**
   * LLM-guided graph traversal: ask LLM what bridge entity is missing,
   * then traverse fact→passage links to find relevant passages.
   * Gate: triggers when FINAL answer is NOT grounded in cited passages.
   */
  private async tryGraphHop(
    corpusId: string,
    question: string,
    _context: ContextBundle,
    firstReasoning: string,
  ): Promise<{ entity: string; passages: readonly Passage[] }> {
    try {
      // Ask LLM to identify the missing bridge entity
      const gatePrompt = `Given this question and the reasoning below, identify the ONE key entity from the context whose related passages would help complete the answer chain. Reply with ONLY the entity name (a person, place, organization, or work title), or "NONE" if no additional lookup is needed.

Question: ${question}

Reasoning so far:
${firstReasoning.substring(0, 500)}

Missing entity:`;

      const gateResult = await this.dependencies.llm.generate({
        prompt: gatePrompt,
        temperature: 0.0,
      });

      const entityName = gateResult.text.trim().replace(/^["']|["']$/g, '').trim();
      if (!entityName || entityName.toUpperCase() === 'NONE' || entityName.length > 100) {
        return { entity: '', passages: [] };
      }

      // Graph traversal: entity name → matching facts → linked passages
      const snapshot = await this.dependencies.memoryStore!.load(corpusId);
      const entityLower = entityName.toLowerCase();

      // Find facts mentioning this entity — exact match first, then substring
      const exactFacts: Fact[] = [];
      const substringFacts: Fact[] = [];
      for (const f of snapshot.facts) {
        const headLower = f.headEntity.toLowerCase();
        const tailLower = f.tailEntity.toLowerCase();
        if (headLower === entityLower || tailLower === entityLower) {
          exactFacts.push(f);
        } else if (
          headLower.includes(entityLower) || tailLower.includes(entityLower)
          || entityLower.includes(headLower) || entityLower.includes(tailLower)
        ) {
          substringFacts.push(f);
        }
      }

      // Prioritize exact matches, then substring matches
      const rankedFacts = [...exactFacts, ...substringFacts];

      // Collect passage IDs from ranked facts
      const passageIds = new Set<string>();
      for (const fact of rankedFacts.slice(0, 30)) {
        for (const pid of fact.passageIds) {
          passageIds.add(pid);
        }
      }

      // Resolve to Passage objects
      const passageMap = new Map(snapshot.passages.map(p => [p.passageId, p]));
      const result: Passage[] = [];
      for (const pid of passageIds) {
        const passage = passageMap.get(pid);
        if (passage) result.push(passage);
        if (result.length >= 5) break;
      }

      return { entity: entityName, passages: result };
    } catch {
      return { entity: '', passages: [] }; // Graceful degradation
    }
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
