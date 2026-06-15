/**
 * Shared query utilities extracted for reuse across query components.
 * DES-MG3-014: extractFinalAnswer shared by QueryService and ComparisonVerifier.
 */

/**
 * Extract the final answer from LLM response text.
 * Looks for "FINAL: ..." line; falls back to the last non-empty line.
 */
export function extractFinalAnswer(llmText: string): string {
  const lines = llmText.trim().split('\n').filter((l) => l.trim());
  const finalLine = lines.find((l) => /^FINAL:/i.test(l.trim()));
  let answer = finalLine
    ? finalLine.replace(/^FINAL:\s*/i, '').trim()
    : (lines[lines.length - 1]?.trim() ?? llmText.trim());
  answer = answer.replace(/^["']|["']$/g, '').trim();
  return answer;
}

/**
 * Escape special regex characters in a string for use in RegExp constructor.
 */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Race a promise against a timeout. Returns null if the timeout fires first.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

// Re-export isComparisonQuery for convenience
export { isComparisonQuery } from './comparisonDetector.js';
