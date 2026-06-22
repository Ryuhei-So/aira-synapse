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
 * Uses normalized substring match; word-boundary check for short answers (≤3 chars).
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

  for (const passage of passages) {
    const normalizedPassage = normalizeForGrounding(passage.text);
    if (normalizedAnswer.length <= 3) {
      // Word-boundary check for very short answers
      const regex = new RegExp(`\\b${escapeRegex(normalizedAnswer)}\\b`);
      if (regex.test(normalizedPassage)) {
        matchedIds.push(passage.id);
      }
    } else {
      if (normalizedPassage.includes(normalizedAnswer)) {
        matchedIds.push(passage.id);
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
