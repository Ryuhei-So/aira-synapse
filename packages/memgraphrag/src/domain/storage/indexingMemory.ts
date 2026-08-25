import type { Fact } from '../memory/fact.js';
import type { Passage } from '../memory/passage.js';
import type { Schema } from '../memory/schema.js';

export const INDEXING_MEMORY_CONTRACT = {
  schema: 'native-indexing-memory@1',
  maxRequestBytes: 64 * 1024 * 1024,
  maxResponseBytes: 8 * 1024 * 1024,
  maxSchemaIds: 4096,
  maxActiveFacts: 100,
  maxDeltaItemsPerSection: 4096,
  maxDomainIdBytes: 4096,
  maxCorpusIdBytes: 1024,
  maxUpdatedAtBytes: 128,
} as const;

export interface IndexingSchemaRequest {
  readonly corpusId: string;
  readonly schemaIds: readonly string[];
}

export interface ActiveFactRequest {
  readonly corpusId: string;
  readonly limit: number;
}

export interface ActivateFactsRequest {
  readonly corpusId: string;
  readonly schemaIds: readonly string[];
  readonly updatedAt: string;
}

export interface IndexingMemoryDelta {
  readonly corpusId: string;
  readonly passages: readonly Passage[];
  readonly facts: readonly Fact[];
  readonly schemas: readonly Schema[];
  readonly exportedAt: string;
}

export interface IndexingMemoryMutationPlan {
  readonly delta: IndexingMemoryDelta;
  readonly activation?: ActivateFactsRequest;
}

/**
 * Corpus-scoped, bounded memory operations used only by document indexing.
 * Full snapshots remain an IMemoryStore compatibility/query concern.
 */
export interface IIndexingMemory {
  getSchemasByIds(request: IndexingSchemaRequest): Promise<readonly Schema[]>;
  getActiveFacts(request: ActiveFactRequest): Promise<readonly Fact[]>;
  /** Pure validation of every input that may enter the mutation phase. */
  preflightMutation(plan: IndexingMemoryMutationPlan): void;
  activateFactsBySchemaIds(request: ActivateFactsRequest): Promise<number>;
  upsertDelta(delta: IndexingMemoryDelta): Promise<void>;
}
