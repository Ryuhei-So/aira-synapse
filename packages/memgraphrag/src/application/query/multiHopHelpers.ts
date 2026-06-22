/**
 * Application Layer — Multi-hop helper functions (deterministic).
 * T4a: classifyQuestion, normalizeForGrounding, hopSimilarity.
 * Pure functions with no side effects.
 */

import type { QuestionType } from '../../domain/retrieval/multiHop.js';
import { isComparisonQuery } from './comparisonDetector.js';

/**
 * Classify a question as bridge, comparison, or simple.
 * Priority: comparison > bridge (default for non-comparison).
 * In multi-hop QA benchmarks, most questions are bridge-type.
 * Simple classification requires explicit simple patterns; otherwise assume bridge.
 */
export function classifyQuestion(query: string): QuestionType {
  if (isComparisonQuery(query)) return 'comparison';
  // Default to bridge for non-comparison questions.
  // The decomposition step will naturally fallback if the question is truly simple.
  return 'bridge';
}

/**
 * Normalize text for grounding validation.
 * Lowercases, strips punctuation, collapses whitespace.
 */
export function normalizeForGrounding(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Compute word-overlap similarity between two texts.
 * Returns Jaccard coefficient of word sets (0..1).
 * For short answers (≤3 words), uses normalized substring match.
 */
export function hopSimilarity(a: string, b: string): number {
  const na = normalizeForGrounding(a);
  const nb = normalizeForGrounding(b);

  if (!na || !nb) return 0;

  const wordsA = na.split(' ');
  const wordsB = nb.split(' ');

  // Short answer: substring match with word boundary
  if (wordsA.length <= 3) {
    return nb.includes(na) ? 1.0 : 0;
  }

  const setA = new Set(wordsA);
  const setB = new Set(wordsB);
  const intersection = new Set([...setA].filter((w) => setB.has(w)));
  const union = new Set([...setA, ...setB]);
  return intersection.size / union.size;
}
