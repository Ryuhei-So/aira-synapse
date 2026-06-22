/**
 * Application Layer — Multi-hop helper functions (deterministic).
 * T4a: classifyQuestion, normalizeForGrounding, hopSimilarity.
 * Pure functions with no side effects.
 */

import type { QuestionType } from '../../domain/retrieval/multiHop.js';
import { isComparisonQuery } from './comparisonDetector.js';

/** Bridge detection patterns (subset from SubQueryDecomposer + extensions). */
const BRIDGE_PATTERNS = [
  /\bthe (?:person|one|man|woman|city|country|team|company|organization|film|movie|book|album|song|show|series|band|group|school|university) (?:who|that|which)\b/i,
  /\bwho(?:'s| is| was| has| had| did)\b.+\b(?:also|then|later|before|after)\b/i,
  /\bwhere (?:did|does|was|is)\b.+\b(?:who|that|which)\b/i,
  /\b(?:born|founded|located|headquartered|based) in\b.+\b(?:who|that|which)\b/i,
  /\b(?:directed|written|produced|composed|created|designed|invented) by\b.+\b(?:who|that|which|also)\b/i,
];

/**
 * Classify a question as bridge, comparison, or simple.
 * Priority: comparison > bridge > simple (per REQ-MH-001).
 */
export function classifyQuestion(query: string): QuestionType {
  if (isComparisonQuery(query)) return 'comparison';
  if (BRIDGE_PATTERNS.some((p) => p.test(query))) return 'bridge';
  return 'simple';
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
