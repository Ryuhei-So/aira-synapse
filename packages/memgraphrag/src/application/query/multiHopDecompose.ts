/**
 * Application Layer — Multi-hop decomposition step.
 * T5b: LLM-based question decomposition + fallback conditions 1-4.
 */

import type { ILLMProvider, TextGenerationRequest } from '../../domain/provider/llmProvider.js';
import type { Decomposition, MultiHopFallbackReason } from '../../domain/retrieval/multiHop.js';

const DECOMPOSITION_SYSTEM_PROMPT = `You are a question decomposition expert. Given a multi-hop question, decompose it into exactly 2 sequential sub-questions.

Rules:
1. hop1SubQuestion: The first sub-question that can be answered independently.
2. hop2SubQuestion: The second sub-question that depends on hop1's answer. MUST contain the literal placeholder {hop1Answer}.
3. bridgeEntityHint (optional): The type of entity that bridges the two hops.

Respond in JSON format ONLY:
{"hop1SubQuestion": "...", "hop2SubQuestion": "... {hop1Answer} ...", "bridgeEntityHint": "..."}`;

export interface DecomposeResult {
  readonly decomposition?: Decomposition;
  readonly fallbackReason?: MultiHopFallbackReason;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

/**
 * Decompose a bridge question into 2 sequential sub-questions via LLM.
 * Returns fallback reason if decomposition fails (conditions 1-4).
 */
export async function decomposeQuestion(
  query: string,
  llm: ILLMProvider,
  signal?: AbortSignal,
): Promise<DecomposeResult> {
  const request: TextGenerationRequest = {
    prompt: `Decompose this question into 2 sub-questions:\n\n"${query}"`,
    systemPrompt: DECOMPOSITION_SYSTEM_PROMPT,
    responseFormat: 'json',
    reasoningEffort: 'low',
    maxTokens: 300,
    signal,
  };

  const response = await llm.generate(request);
  const usage = { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens };

  // Fallback 1: JSON parse error
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    return { fallbackReason: 'decomposition_parse_error', usage };
  }

  // Fallback 2: Missing required fields
  if (
    typeof parsed.hop1SubQuestion !== 'string' || !parsed.hop1SubQuestion.trim() ||
    typeof parsed.hop2SubQuestion !== 'string' || !parsed.hop2SubQuestion.trim()
  ) {
    return { fallbackReason: 'decomposition_missing_field', usage };
  }

  const hop1SubQuestion = (parsed.hop1SubQuestion as string).trim();
  const hop2SubQuestion = (parsed.hop2SubQuestion as string).trim();

  // Fallback 3: Missing {hop1Answer} placeholder
  if (!hop2SubQuestion.includes('{hop1Answer}')) {
    return { fallbackReason: 'decomposition_missing_placeholder', usage };
  }

  // Fallback 4: Duplicate hop questions
  if (hop1SubQuestion.toLowerCase() === hop2SubQuestion.replace(/\{hop1Answer\}/g, '').trim().toLowerCase()) {
    return { fallbackReason: 'decomposition_duplicate_hops', usage };
  }

  const decomposition: Decomposition = {
    hop1SubQuestion,
    hop2SubQuestion,
    bridgeEntityHint: typeof parsed.bridgeEntityHint === 'string' ? parsed.bridgeEntityHint.trim() || undefined : undefined,
  };

  return { decomposition, usage };
}
