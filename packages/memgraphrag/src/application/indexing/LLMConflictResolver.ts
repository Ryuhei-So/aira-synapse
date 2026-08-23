/**
 * LLM-based Conflict Resolver — Stage III.
 *
 * Uses LLM to resolve detected conflicts between facts based on
 * evidence from source passages. Implements three conflict types:
 *   - Mutual exclusion: Same subject+predicate, different objects
 *   - Temporal: Time-dependent facts with overlapping scopes
 *   - Granularity: Different specificity levels
 *
 * Resolution strategies: keep, discard, or modify facts.
 */
import type { ILLMProvider } from '../../domain/provider/index.js';
import type {
  IConflictResolver,
  ConflictResolutionRequest,
  ConflictResolution,
  ConflictResolutionState,
  ResolutionEvidence,
} from '../../domain/agent/conflictResolution.js';
import type { ConflictType } from '../../domain/agent/conflictDetection.js';

function buildResolutionPrompt(request: ConflictResolutionRequest): string {
  const { conflictSet, evidencePassages } = request;
  const newFact = conflictSet.newFact;
  const conflicting = conflictSet.conflictingFacts;

  const passageTexts = evidencePassages
    .map((p, i) => `[Passage ${i + 1}] ${p.text.slice(0, 500)}`)
    .join('\n\n');

  const conflictingLines = conflicting
    .map((f, i) => `  ${i + 1}. (${f.headEntity}, ${f.relation}, ${f.tailEntity})`)
    .join('\n');

  return `You are a knowledge graph conflict resolver. Analyze the following conflict and decide which facts to keep.

## Conflict Type: ${conflictSet.conflictType}

## New Fact (under review):
  (${newFact.headEntity}, ${newFact.relation}, ${newFact.tailEntity})

## Existing Conflicting Facts:
${conflictingLines}

## Source Passages:
${passageTexts}

## Instructions:
Based on the source passages, determine:
1. Which fact(s) are correct according to the evidence
2. Which fact(s) should be discarded or modified

Respond in JSON format:
{
  "decision": "keep_new" | "keep_existing" | "keep_both" | "discard_both",
  "confidence": 0.0-1.0,
  "rationale": "brief explanation",
  "keep_fact_indices": [0-based indices of facts to keep from the conflicting list],
  "discard_fact_indices": [0-based indices of facts to discard]
}

If "keep_new", the new fact replaces conflicting ones.
If "keep_existing", the new fact is discarded.
If "keep_both", no conflict (both are valid, perhaps in different contexts).
If "discard_both", neither fact has sufficient evidence.`;
}

interface LLMResolutionResponse {
  decision: 'keep_new' | 'keep_existing' | 'keep_both' | 'discard_both';
  confidence: number;
  rationale: string;
  keep_fact_indices?: number[];
  discard_fact_indices?: number[];
}

const RESOLUTION_DECISIONS = new Set<LLMResolutionResponse['decision']>([
  'keep_new',
  'keep_existing',
  'keep_both',
  'discard_both',
]);

function parseResolutionResponse(text: string): LLMResolutionResponse | null {
  // Extract JSON from response (may have markdown code blocks)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(jsonMatch[0]);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    if (typeof value.decision !== 'string'
      || !RESOLUTION_DECISIONS.has(value.decision as LLMResolutionResponse['decision'])
      || typeof value.confidence !== 'number'
      || !Number.isFinite(value.confidence)
      || value.confidence < 0
      || value.confidence > 1
      || typeof value.rationale !== 'string'
      || value.rationale.trim().length === 0) {
      return null;
    }
    for (const field of ['keep_fact_indices', 'discard_fact_indices'] as const) {
      const indices = value[field];
      if (indices !== undefined && (!Array.isArray(indices)
        || indices.some((index) => !Number.isSafeInteger(index) || (index as number) < 0))) {
        return null;
      }
    }
    return {
      decision: value.decision as LLMResolutionResponse['decision'],
      confidence: value.confidence,
      rationale: value.rationale,
      ...(value.keep_fact_indices === undefined
        ? {} : { keep_fact_indices: value.keep_fact_indices as number[] }),
      ...(value.discard_fact_indices === undefined
        ? {} : { discard_fact_indices: value.discard_fact_indices as number[] }),
    };
  } catch {
    return null;
  }
}

function retainedStateForKeepBoth(conflictType: ConflictType): ConflictResolutionState {
  switch (conflictType) {
    case 'temporal': return 'temporalized';
    case 'granularity': return 'granularity_linked';
    case 'mutually_exclusive': return 'unresolved';
  }
}

function unresolvedResolution(
  request: ConflictResolutionRequest,
  rationale: string,
): ConflictResolution {
  const allFactIds = [
    request.conflictSet.newFact.factId,
    ...request.conflictSet.conflictingFacts.map((fact) => fact.factId),
  ];
  return {
    state: 'unresolved',
    confidence: 0,
    keptFactIds: allFactIds,
    inactivatedFactIds: [],
    derivedFacts: [],
    evidence: request.evidencePassages.map((passage) => ({
      passageId: passage.passageId,
      supportsFactIds: allFactIds,
      rationale,
    })),
  };
}

export class LLMConflictResolver implements IConflictResolver {
  constructor(private readonly llm: ILLMProvider) {}

  public async resolve(request: ConflictResolutionRequest): Promise<ConflictResolution> {
    const { conflictSet, evidencePassages } = request;
    const prompt = buildResolutionPrompt(request);

    try {
      const result = await this.llm.generate({ prompt, temperature: 0.0 });
      const parsed = parseResolutionResponse(result.text);
      if (!parsed) {
        return unresolvedResolution(request, 'Invalid LLM conflict resolution response');
      }

      const allFactIds = [
        conflictSet.newFact.factId,
        ...conflictSet.conflictingFacts.map(f => f.factId),
      ];

      let keptFactIds: string[];
      let inactivatedFactIds: string[];

      let state: ConflictResolutionState;
      switch (parsed.decision) {
        case 'keep_new':
          state = 'resolved_keep_new';
          keptFactIds = [conflictSet.newFact.factId];
          inactivatedFactIds = conflictSet.conflictingFacts.map(f => f.factId);
          break;
        case 'keep_existing':
          state = 'resolved_keep_existing';
          keptFactIds = conflictSet.conflictingFacts.map(f => f.factId);
          inactivatedFactIds = [conflictSet.newFact.factId];
          break;
        case 'keep_both':
          state = retainedStateForKeepBoth(conflictSet.conflictType);
          keptFactIds = allFactIds;
          inactivatedFactIds = [];
          break;
        case 'discard_both':
          return unresolvedResolution(request, parsed.rationale);
      }

      const evidence: ResolutionEvidence[] = evidencePassages.map(p => ({
        passageId: p.passageId,
        supportsFactIds: keptFactIds,
        rationale: parsed.rationale,
      }));

      return {
        state,
        confidence: parsed.confidence,
        keptFactIds,
        inactivatedFactIds,
        derivedFacts: [],
        evidence,
      };
    } catch {
      return unresolvedResolution(request, 'LLM conflict resolution provider failure');
    }
  }
}
