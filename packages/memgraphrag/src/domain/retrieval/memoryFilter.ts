/**
 * Domain Layer — Memory Filter and Node Initializer retrieval ports.
 * DES-MG-008: Three-layer parallel Top-K filtering and node initialization.
 */

import type { MemoryLayer } from '../memory/types.js';
import type { Schema } from '../memory/schema.js';
import type { Fact } from '../memory/fact.js';
import type { Passage } from '../memory/passage.js';

export interface QueryRequest {
  readonly corpusId: string;
  readonly text: string;
  readonly topK: number;
  readonly topM: number;
  readonly threshold: number;
  readonly contextTokenLimit: number;
}

export interface MemoryCandidate<TItem> {
  readonly layer: MemoryLayer;
  readonly item: TItem;
  readonly similarity: number;
}

export interface FilteredMemoryCandidates {
  readonly ontology: readonly MemoryCandidate<Schema>[];
  readonly facts: readonly MemoryCandidate<Fact>[];
  readonly passages: readonly MemoryCandidate<Passage>[];
  readonly expandedTerms: readonly string[];
  readonly fallbackRequired: boolean;
}

export interface NodeInitializationVector {
  readonly scores: Readonly<Record<string, number>>;
  readonly fallbackTriggered: boolean;
}

export interface NodeInitializationRequest {
  readonly query: QueryRequest;
  readonly candidates: FilteredMemoryCandidates;
}

export interface IMemoryFilter {
  filter(request: QueryRequest): Promise<FilteredMemoryCandidates>;
}

export interface INodeInitializer {
  initialize(
    request: NodeInitializationRequest,
  ): Promise<NodeInitializationVector>;
}
