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

function parseResolutionResponse(text: string): LLMResolutionResponse {
  // Extract JSON from response (may have markdown code blocks)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { decision: 'keep_both', confidence: 0.3, rationale: 'Could not parse LLM response' };
  }
  try {
    return JSON.parse(jsonMatch[0]) as LLMResolutionResponse;
  } catch {
    return { decision: 'keep_both', confidence: 0.3, rationale: 'JSON parse error' };
  }
}

function mapDecisionToState(decision: string): ConflictResolutionState {
  switch (decision) {
    case 'keep_new': return 'resolved_keep_new';
    case 'keep_existing': return 'resolved_keep_existing';
    case 'keep_both': return 'merged';
    case 'discard_both': return 'resolved_keep_existing';
    default: return 'unresolved';
  }
}

export class LLMConflictResolver implements IConflictResolver {
  constructor(private readonly llm: ILLMProvider) {}

  public async resolve(request: ConflictResolutionRequest): Promise<ConflictResolution> {
    const { conflictSet, evidencePassages } = request;
    const prompt = buildResolutionPrompt(request);

    try {
      const result = await this.llm.generate({ prompt, temperature: 0.0 });
      const parsed = parseResolutionResponse(result.text);

      const allFactIds = [
        conflictSet.newFact.factId,
        ...conflictSet.conflictingFacts.map(f => f.factId),
      ];

      let keptFactIds: string[];
      let inactivatedFactIds: string[];

      switch (parsed.decision) {
        case 'keep_new':
          keptFactIds = [conflictSet.newFact.factId];
          inactivatedFactIds = conflictSet.conflictingFacts.map(f => f.factId);
          break;
        case 'keep_existing':
          keptFactIds = conflictSet.conflictingFacts.map(f => f.factId);
          inactivatedFactIds = [conflictSet.newFact.factId];
          break;
        case 'keep_both':
          keptFactIds = allFactIds;
          inactivatedFactIds = [];
          break;
        case 'discard_both':
          keptFactIds = [];
          inactivatedFactIds = allFactIds;
          break;
        default:
          keptFactIds = allFactIds;
          inactivatedFactIds = [];
      }

      const evidence: ResolutionEvidence[] = evidencePassages.map(p => ({
        passageId: p.passageId,
        supportsFactIds: keptFactIds,
        rationale: parsed.rationale,
      }));

      return {
        state: mapDecisionToState(parsed.decision),
        confidence: parsed.confidence,
        keptFactIds,
        inactivatedFactIds,
        derivedFacts: [],
        evidence,
      };
    } catch {
      // On LLM failure, keep all facts (conservative)
      return {
        state: 'unresolved',
        confidence: 0,
        keptFactIds: [
          conflictSet.newFact.factId,
          ...conflictSet.conflictingFacts.map(f => f.factId),
        ],
        inactivatedFactIds: [],
        derivedFacts: [],
        evidence: [],
      };
    }
  }
}
