/**
 * Domain Layer — Query Rewriter interface for multi-hop query decomposition.
 * DES-MG4-005 (REQ-MG4-005, REQ-MG4-006): Staged query execution with fallback.
 */

import type { PPRResult } from './ppr.js';
import type { QueryRequest } from './memoryFilter.js';

export interface SubQuery {
  readonly step: number;
  readonly query: string;
  readonly dependsOn?: number;
  readonly purpose: string;
}

export interface RewriteRequest {
  readonly query: QueryRequest;
}

export interface RewriteResult {
  readonly decomposed: boolean;
  readonly subQueries: readonly SubQuery[];
  readonly intermediateAnswers: readonly string[];
  readonly mergedRanking: PPRResult;
  readonly fallback: boolean;
  readonly fallbackReason?: string;
}

export interface IQueryRewriter {
  rewrite(request: RewriteRequest): Promise<RewriteResult>;
}
