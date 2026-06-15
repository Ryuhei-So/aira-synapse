/**
 * Application Layer — Comparison answer verification.
 * DES-MG3-014: Verifies that comparison/yes-no answers include explicit
 * attribute values for each compared entity before deriving the answer.
 */

import type { ILLMProvider } from '../../domain/provider/index.js';
import { extractFinalAnswer } from './query-utils.js';

export interface ComparisonVerifyResult {
  readonly response: string;
  readonly verified: boolean;
}

import type { ReasoningEffort, Verbosity } from '../../domain/provider/llmProvider.js';

export interface ComparisonHyperParams {
  readonly reasoningEffort?: ReasoningEffort;
  readonly verbosity?: Verbosity;
}

export class ComparisonVerifier {
  constructor(private readonly llm: ILLMProvider) {}

  public async verify(
    initialAnswer: string,
    rawResponse: string,
    query: string,
    context: string,
    hyperParams: ComparisonHyperParams,
  ): Promise<ComparisonVerifyResult> {
    if (this.hasExplicitComparison(rawResponse)) {
      return { response: initialAnswer, verified: true };
    }

    // Re-generate with enhanced prompt (one attempt only)
    const enhancedPrompt = `${query}\n\nIMPORTANT: Before giving your yes/no answer, you MUST explicitly state the relevant attribute or value for EACH entity being compared. Then derive your answer from those values.\n\nContext:\n${context}\n\nReasoning and answer:`;

    try {
      const result = await this.llm.generate({
        prompt: enhancedPrompt,
        temperature: 0.0,
        reasoningEffort: hyperParams.reasoningEffort,
        verbosity: hyperParams.verbosity,
      });

      const regenerated = extractFinalAnswer(result.text);
      if (this.hasExplicitComparison(result.text)) {
        return { response: regenerated, verified: true };
      }
    } catch {
      // LLM failure → return initial answer
    }

    // Regeneration failed or still insufficient → return initial (no answer refusal)
    return { response: initialAnswer, verified: false };
  }

  private hasExplicitComparison(response: string): boolean {
    // Look for patterns indicating explicit attribute comparison:
    // "X is/was/has ... while/whereas/but Y is/was/has ..."
    // or numbered/bulleted lists comparing entities
    const comparisonPatterns = [
      /\b(?:while|whereas|but|however|on the other hand)\b/i,
      /(?:entity|first|second|former|latter)\b.*\b(?:is|was|has|had)\b/i,
      /\b\d+[\.\)]\s+\w+.*\b\d+[\.\)]\s+\w+/s,
    ];

    return comparisonPatterns.some((p) => p.test(response));
  }
}
