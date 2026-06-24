/**
 * Domain Layer — Federation retrieval types.
 * DES-FED-001: Retrieve/Answer split types for federated query support.
 */

import type { Fact } from '../memory/fact.js';
import type { Passage } from '../memory/passage.js';
import type { PPRResult, ContextBundle } from './ppr.js';
import type { QueryRequest } from './memoryFilter.js';

// ─── Ranked results with optional DB provenance ───

export interface RankedPassage {
  readonly passage: Passage;
  readonly score: number;
  readonly rank: number;
  readonly dbId?: string;
}

export interface RankedFact {
  readonly fact: Fact;
  readonly score: number;
  readonly rank: number;
  readonly dbId?: string;
}

// ─── Retrieval metrics (per-DB) ───

export interface RetrievalMetrics {
  readonly dictionaryMatchCount: number;
  readonly expandedTerms: readonly string[];
  readonly fallbackTriggered: boolean;
  readonly pprIterations: number;
  readonly pprConverged: boolean;
  readonly citedPassageCount: number;
  readonly latencyMs: number;
}

// ─── PreparedQuery — output of prepare(), input to retrievePrepared() ───

export interface PreparedQuery {
  readonly normalizedText: string;
  readonly expandedRequest: QueryRequest;
  readonly entityHits: readonly EntityHitInfo[];
  readonly dictionaryHints: string;
  readonly isComparison: boolean;
}

/** Minimal entity hit info for PreparedQuery (no import cycle with QueryService). */
export interface EntityHitInfo {
  readonly term: string;
  readonly matchedText: string;
  readonly boostFactor: number;
}

// ─── RetrievedQueryContext — output of retrieve(), input to answer() ───

export interface RetrievedQueryContext {
  readonly passages: readonly RankedPassage[];
  readonly facts: readonly RankedFact[];
  readonly pprResult: PPRResult;
  readonly contextBundle: ContextBundle;
  readonly normalizedText: string;
  readonly expandedRequest: QueryRequest;
  readonly entityHits: readonly EntityHitInfo[];
  readonly dictionaryHints: string;
  readonly isComparison: boolean;
  readonly queryVector: readonly number[];
  readonly metrics: RetrievalMetrics;
}
