/**
 * Domain Layer — Passage Reranker interface for LLM-based relevance scoring.
 * DES-MG4-006 (REQ-MG4-007): Reorder PPR passages by query relevance.
 */

import type { PPRResult } from './ppr.js';

export interface RerankRequest {
  readonly query: string;
  readonly ranking: PPRResult;
  readonly topN: number;      // Number of passages to rerank (default: 20)
  readonly selectN: number;   // Final selection count (default: 10)
}

export interface RerankMetrics {
  readonly positionChanges: number;
  readonly scoreRange: { min: number; max: number; median: number };
  readonly latencyMs: number;
  readonly tokensUsed: number;
}

export interface RerankResult {
  readonly rerankedPPRResult: PPRResult;
  readonly metrics: RerankMetrics;
}

export interface IPassageReranker {
  rerank(request: RerankRequest): Promise<RerankResult>;
}
