/**
 * Application Layer — Federation types for multi-DB query.
 * DES-FED-002, DES-FED-003, DES-FED-006, DES-FED-007.
 */

import type { Passage } from '../../domain/memory/passage.js';
import type { Fact } from '../../domain/memory/fact.js';
import type { RetrievedQueryContext, RankedPassage, RankedFact } from '../../domain/retrieval/federation.js';

// ─── Database Configuration ───

/** DB ID must match [a-zA-Z0-9_-] only (no colon). */
const DB_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function isValidDbId(dbId: string): boolean {
  return DB_ID_PATTERN.test(dbId);
}

export interface FederatedDbConfig {
  readonly dbId: string;
  readonly dbPath: string;
  readonly weight?: number;
  readonly corpusId?: string;
}

export interface FederatedQueryConfig {
  readonly databases: readonly FederatedDbConfig[];
  readonly rrfK: number;
  readonly perDbTopK: number;
  readonly globalTopK: number;
  readonly maxContributionRatio: number;
  readonly contextTokenBudget: number;
  readonly perDbTimeoutMs: number;
  readonly maxParallelism: number;
}

export const DEFAULT_FEDERATION_CONFIG: Omit<FederatedQueryConfig, 'databases'> = {
  rrfK: 60,
  perDbTopK: 10,
  globalTopK: 10,
  maxContributionRatio: 0.7,
  contextTokenBudget: 3000,
  perDbTimeoutMs: 30000,
  maxParallelism: 5,
};

// ─── RRF Merger Types ───

export interface RRFConfig {
  readonly k: number;
  readonly globalTopK: number;
  readonly maxContributionRatio: number;
  readonly contextTokenBudget: number;
}

export interface NamespacedRetrievedContext {
  readonly dbId: string;
  readonly context: RetrievedQueryContext;
  readonly weight: number;
}

export interface MergedPassage {
  readonly passage: Passage;
  readonly rrfScore: number;
  readonly sourceDbId: string;
  readonly originalRank: number;
  readonly approxTokens: number;
}

export interface MergedFact {
  readonly fact: Fact;
  readonly rrfScore: number;
  readonly sourceDbId: string;
  readonly originalRank: number;
  readonly approxTokens: number;
}

export interface MergedQueryContext extends RetrievedQueryContext {
  readonly mergedPassages: readonly MergedPassage[];
  readonly mergedFacts: readonly MergedFact[];
  readonly dbContributions: Record<string, number>;
  readonly deduplicatedCount: number;
}

export interface IRRFMerger {
  merge(
    contexts: readonly NamespacedRetrievedContext[],
    config: RRFConfig,
  ): MergedQueryContext;
}

// ─── Per-DB Result Types ───

export interface FederatedDbResult {
  readonly dbId: string;
  readonly status: 'success' | 'failure' | 'timeout';
  readonly context?: RetrievedQueryContext;
  readonly error?: string;
  readonly latencyMs: number;
}

export interface FederatedDbMetric {
  readonly dbId: string;
  readonly status: 'success' | 'failure' | 'timeout';
  readonly latencyMs: number;
  readonly hitCount: number;
  readonly error?: string;
}

// ─── Error ───

export class FederatedQueryError extends Error {
  public readonly name = 'FederatedQueryError';

  public constructor(
    message: string,
    public readonly dbResults: readonly { dbId: string; status: string; error?: string }[],
  ) {
    super(message);
  }
}

// ─── Namespacing Utilities ───

export function namespacePassage(dbId: string, passage: Passage): Passage {
  return {
    ...passage,
    passageId: `${dbId}:${passage.passageId}`,
    factIds: (passage.factIds ?? []).map((id) => `${dbId}:${id}`),
    metadata: {
      ...passage.metadata,
      documentId: `${dbId}:${passage.metadata.documentId}`,
    },
  };
}

export function namespaceFact(dbId: string, fact: Fact): Fact {
  return {
    ...fact,
    factId: `${dbId}:${fact.factId}`,
    schemaId: `${dbId}:${fact.schemaId}`,
    passageIds: (fact.passageIds ?? []).map((id) => `${dbId}:${id}`),
    sourceDocumentIds: (fact.sourceDocumentIds ?? []).map((id) => `${dbId}:${id}`),
  };
}

export function namespaceRankedPassage(dbId: string, rp: RankedPassage): RankedPassage {
  return {
    ...rp,
    passage: namespacePassage(dbId, rp.passage),
    dbId,
  };
}

export function namespaceRankedFact(dbId: string, rf: RankedFact): RankedFact {
  return {
    ...rf,
    fact: namespaceFact(dbId, rf.fact),
    dbId,
  };
}
