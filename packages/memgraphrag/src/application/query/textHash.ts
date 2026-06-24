/**
 * Application Layer — Text hash utility for deduplication.
 * DES-FED-003: Deterministic text normalization + SHA-256 hash for passage dedup.
 */

import { createHash } from 'node:crypto';

/**
 * Normalize text for deduplication comparison.
 * Collapses whitespace, trims, and lowercases.
 */
export function normalizeTextForDedup(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Compute a deterministic dedup key from text.
 * Uses SHA-256 of normalized text, truncated to 16 hex chars.
 */
export function computeTextHash(text: string): string {
  const normalized = normalizeTextForDedup(text);
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * Compute a composite dedup key from sourceUrl and text.
 * Two passages are considered duplicates if this key matches.
 */
export function computePassageDedupeKey(sourceUrl: string, text: string): string {
  return `${sourceUrl}::${computeTextHash(text)}`;
}
