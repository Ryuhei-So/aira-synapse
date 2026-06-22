/**
 * Application Layer — Multi-hop LLM output parsing helpers.
 * T4b: parseHopOutput, validateGrounding, majorityVote.
 */

import type { HopResult } from '../../domain/retrieval/multiHop.js';
import { normalizeForGrounding } from './multiHopHelpers.js';
import { extractFinalAnswer } from './query-utils.js';

/**
 * Parse LLM hop output to extract answer text.
 * Looks for "FINAL:" line, falls back to last non-empty line.
 */
export function parseHopOutput(llmText: string): string {
  return extractFinalAnswer(llmText);
}

/**
 * Validate that a hop answer is grounded in the provided passages.
 * Uses multi-strategy matching:
 * 1. Normalized substring match (exact)
 * 2. Word-boundary check for short answers (≤3 chars)
 * 3. Word-overlap similarity (Jaccard ≥ 0.6) for longer answers
 */
export function validateGrounding(
  answer: string,
  passages: readonly { id: string; text: string }[],
): { grounded: boolean; passageIds: string[] } {
  if (!answer.trim()) {
    return { grounded: false, passageIds: [] };
  }

  const normalizedAnswer = normalizeForGrounding(answer);
  if (!normalizedAnswer) {
    return { grounded: false, passageIds: [] };
  }

  const matchedIds: string[] = [];
  const answerWords = normalizedAnswer.split(' ').filter((w) => w.length > 1);

  for (const passage of passages) {
    const normalizedPassage = normalizeForGrounding(passage.text);

    // Strategy 1: Exact substring match
    if (normalizedAnswer.length <= 3) {
      const regex = new RegExp(`\\b${escapeRegex(normalizedAnswer)}\\b`);
      if (regex.test(normalizedPassage)) {
        matchedIds.push(passage.id);
        continue;
      }
    } else if (normalizedPassage.includes(normalizedAnswer)) {
      matchedIds.push(passage.id);
      continue;
    }

    // Strategy 2: Word-overlap (Jaccard ≥ 0.6 for multi-word answers)
    if (answerWords.length >= 2) {
      const passageWords = new Set(normalizedPassage.split(' '));
      const matchCount = answerWords.filter((w) => passageWords.has(w)).length;
      const ratio = matchCount / answerWords.length;
      if (ratio >= 0.6) {
        matchedIds.push(passage.id);
        continue;
      }
    }

    // Strategy 3: Each significant word (≥4 chars) found in passage
    if (answerWords.length >= 1 && answerWords.length <= 3) {
      const significantWords = answerWords.filter((w) => w.length >= 4);
      if (significantWords.length > 0) {
        const allFound = significantWords.every((w) => normalizedPassage.includes(w));
        if (allFound) {
          matchedIds.push(passage.id);
          continue;
        }
      }
    }
  }

  return { grounded: matchedIds.length > 0, passageIds: matchedIds };
}

/**
 * Majority vote from multiple answers (self-consistency).
 * Returns the most frequent answer and cited passage IDs from winner(s).
 */
export function majorityVote(
  candidates: readonly HopResult[],
): { answer: string; passageIds: string[] } {
  if (candidates.length === 0) {
    return { answer: '', passageIds: [] };
  }

  // Count by normalized answer
  const counts = new Map<string, { original: string; count: number; passageIds: Set<string> }>();

  for (const c of candidates) {
    const key = normalizeForGrounding(c.answer);
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
      for (const id of c.passageIds) existing.passageIds.add(id);
    } else {
      counts.set(key, {
        original: c.answer,
        count: 1,
        passageIds: new Set(c.passageIds),
      });
    }
  }

  // Find max count
  let winner = { original: '', count: 0, passageIds: new Set<string>() };
  for (const entry of counts.values()) {
    if (entry.count > winner.count) {
      winner = entry;
    }
  }

  return {
    answer: winner.original,
    passageIds: [...winner.passageIds],
  };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
