/**
 * Application Layer — Multi-hop hop execution step.
 * T5c: hop-1 and hop-2 execution with grounding validation (fallback 5-8).
 */

import type { ILLMProvider, TextGenerationRequest } from '../../domain/provider/llmProvider.js';
import type { HopResult, MultiHopFallbackReason } from '../../domain/retrieval/multiHop.js';
import { parseHopOutput, validateGrounding } from './multiHopParsers.js';

const HOP_SYSTEM_PROMPT = `You are a precise question-answering assistant. Answer the question using ONLY the provided passages. Give a short, factual answer.

End your response with:
FINAL: <your answer>`;

export interface HopExecutionResult {
  readonly hop?: HopResult;
  readonly fallbackReason?: MultiHopFallbackReason;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

/**
 * Execute a single hop (either hop-1 or hop-2).
 * Validates that the answer is grounded in passages.
 */
export async function executeHop(
  subQuestion: string,
  passages: readonly { id: string; text: string }[],
  llm: ILLMProvider,
  hopLabel: 'hop1' | 'hop2',
  signal?: AbortSignal,
): Promise<HopExecutionResult> {
  const contextStr = passages
    .map((p, i) => `[${i + 1}] (${p.id}) ${p.text}`)
    .join('\n\n');

  const request: TextGenerationRequest = {
    prompt: `Passages:\n${contextStr}\n\nQuestion: ${subQuestion}`,
    systemPrompt: HOP_SYSTEM_PROMPT,
    reasoningEffort: hopLabel === 'hop1' ? 'medium' : 'high',
    verbosity: 'low',
    maxTokens: 200,
    signal,
  };

  const response = await llm.generate(request);
  const usage = { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens };

  const answer = parseHopOutput(response.text);

  // Fallback 5/7: empty answer
  if (!answer.trim()) {
    const reason: MultiHopFallbackReason = hopLabel === 'hop1' ? 'hop1_empty' : 'hop2_empty';
    return { fallbackReason: reason, usage };
  }

  // Validate grounding
  const grounding = validateGrounding(answer, passages);

  // Fallback 6/8: ungrounded
  if (!grounding.grounded) {
    const reason: MultiHopFallbackReason = hopLabel === 'hop1' ? 'hop1_ungrounded' : 'hop2_ungrounded';
    return {
      hop: { answer, passageIds: [], grounded: false },
      fallbackReason: reason,
      usage,
    };
  }

  return {
    hop: { answer, passageIds: grounding.passageIds, grounded: true },
    usage,
  };
}
