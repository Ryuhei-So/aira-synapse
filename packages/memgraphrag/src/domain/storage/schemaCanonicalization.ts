import type { GraphNode } from './graphStore.js';
import type { IndexingMemoryDelta } from './indexingMemory.js';
import type { IndexingMemoryUpsertResult } from './indexingMemory.js';
import type { SchemaAlias, Schema } from '../memory/schema.js';
import type { SchemaState } from '../memory/types.js';

/**
 * The negotiated C1-S native contract.  This is deliberately separate from
 * INDEXING_MEMORY_CONTRACT: the legacy full-schema lane keeps its existing
 * request and response shapes and limits.
 */
export const SCHEMA_CANONICALIZATION_CONTRACT = {
  schema: 'native-schema-canonicalization@1',
  projection: 'canonicalization@1',
  merge: 'preserve-cas@1',
  graphHydration: 'memory-schema@1',
  maxProjectedSchemas: 32,
  maxSchemaMerges: 32,
  maxGraphHydrations: 32,
  maxAliasAdditions: 4096,
  maxFactIdAdditions: 4096,
  maxSchemaNodeIdBytes: 4103,
  maxSchemaNodeLabelBytes: 12290,
} as const;

export interface SchemaCanonicalizationCapability {
  readonly schema: typeof SCHEMA_CANONICALIZATION_CONTRACT.schema;
  readonly projection: typeof SCHEMA_CANONICALIZATION_CONTRACT.projection;
  readonly merge: typeof SCHEMA_CANONICALIZATION_CONTRACT.merge;
  readonly graphHydration: typeof SCHEMA_CANONICALIZATION_CONTRACT.graphHydration;
  readonly maxProjectedSchemas: typeof SCHEMA_CANONICALIZATION_CONTRACT.maxProjectedSchemas;
  readonly maxSchemaMerges: typeof SCHEMA_CANONICALIZATION_CONTRACT.maxSchemaMerges;
  readonly maxGraphHydrations: typeof SCHEMA_CANONICALIZATION_CONTRACT.maxGraphHydrations;
  readonly maxAliasAdditions: typeof SCHEMA_CANONICALIZATION_CONTRACT.maxAliasAdditions;
  readonly maxFactIdAdditions: typeof SCHEMA_CANONICALIZATION_CONTRACT.maxFactIdAdditions;
  readonly maxSchemaNodeIdBytes: typeof SCHEMA_CANONICALIZATION_CONTRACT.maxSchemaNodeIdBytes;
  readonly maxSchemaNodeLabelBytes: typeof SCHEMA_CANONICALIZATION_CONTRACT.maxSchemaNodeLabelBytes;
}

export interface SchemaCanonicalizationProjectionRequest {
  readonly corpusId: string;
  readonly schemaIds: readonly string[];
  readonly projection: typeof SCHEMA_CANONICALIZATION_CONTRACT.projection;
  readonly contributionDocumentId: string;
}

/** The bounded DTO returned by the canonicalization projection. */
export interface SchemaCanonicalizationProjection {
  readonly schemaId: string;
  readonly corpusId: string;
  readonly headType: string;
  readonly relation: string;
  readonly tailType: string;
  readonly canonicalKey: string;
  readonly frequency: number;
  readonly state: SchemaState;
  readonly stabilizationThreshold: number;
  readonly firstSourceDocumentId: string | null;
  readonly contributionPresent: boolean;
  /** Opaque SHA-256 token over the complete native schema value. */
  readonly mergeToken: string;
}

export interface SchemaCanonicalizationMergeCreate {
  readonly mode: 'create';
  readonly expectedAbsent: true;
  /** Create is the only projected wire shape that carries a full Schema. */
  readonly schema: Schema;
}

export interface SchemaCanonicalizationMergeExisting {
  readonly mode: 'merge';
  readonly schemaId: string;
  readonly expectedMergeToken: string;
  readonly contributionDocumentId: string;
  readonly frequencyDelta: number;
  readonly desiredState: SchemaState;
  readonly stabilizationThreshold: number;
  readonly updatedAt: string;
  readonly aliasAdditions: readonly SchemaAlias[];
  readonly factIdAdditions: readonly string[];
}

/** Discriminated so projected callers cannot accidentally send a fake Schema. */
export type SchemaMergeIntent =
  | SchemaCanonicalizationMergeCreate
  | SchemaCanonicalizationMergeExisting;

/** Legacy full-schema mutation shape, kept distinct from the projected lane. */
export type LegacyIndexingMemoryWireDelta = IndexingMemoryDelta & {
  readonly schemaMerges?: never;
};

/** Projected mutation shape.  The `schemas` key must be omitted completely. */
export type SchemaCanonicalizationMemoryDelta = Omit<IndexingMemoryDelta, 'schemas'> & {
  readonly schemaMerges: readonly SchemaMergeIntent[];
  readonly schemas?: never;
};

export type IndexingMemoryWireDelta =
  | LegacyIndexingMemoryWireDelta
  | SchemaCanonicalizationMemoryDelta;

export interface SchemaNodeReference {
  readonly nodeId: string;
  readonly corpusId: string;
  readonly schemaId: string;
  readonly label: string;
}

/** Optional negotiated fields on the existing upsert_nodes request. */
export interface SchemaHydrationWireParams {
  readonly nodes: readonly GraphNode[];
  readonly schemaRefHydration: typeof SCHEMA_CANONICALIZATION_CONTRACT.graphHydration;
  readonly schemaNodeRefs: readonly SchemaNodeReference[];
}

/** Existing upsert_nodes wire shape, retained for compatibility. */
export interface LegacyGraphUpsertWireParams {
  readonly nodes: readonly GraphNode[];
  readonly schemaRefHydration?: never;
  readonly schemaNodeRefs?: never;
}

export type GraphUpsertWireParams =
  | LegacyGraphUpsertWireParams
  | SchemaHydrationWireParams;

/** Optional native capability owned by the indexing-memory adapter. */
export interface ISchemaCanonicalizationMemory {
  readonly schemaCanonicalizationCapability?: SchemaCanonicalizationCapability;
  /** Pure validation before provider work or a memory mutation. */
  preflightSchemaCanonicalizationDelta(delta: SchemaCanonicalizationMemoryDelta): void;
  getSchemaCanonicalizationProjection(
    request: SchemaCanonicalizationProjectionRequest,
  ): Promise<readonly SchemaCanonicalizationProjection[]>;
  upsertSchemaCanonicalizationDelta(
    delta: SchemaCanonicalizationMemoryDelta,
  ): Promise<IndexingMemoryUpsertResult | void>;
}

/** Optional native graph boundary; legacy IGraphStore remains unchanged. */
export interface ISchemaHydratingGraphStore {
  /** Pure validation before provider work or graph persistence. */
  preflightSchemaHydration(params: SchemaHydrationWireParams): void;
  upsertNodesWithSchemaHydration(params: SchemaHydrationWireParams): Promise<void>;
}

export function isSchemaCanonicalizationMemory(
  value: unknown,
): value is ISchemaCanonicalizationMemory {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ISchemaCanonicalizationMemory>;
  return typeof candidate.preflightSchemaCanonicalizationDelta === 'function'
    && typeof candidate.getSchemaCanonicalizationProjection === 'function'
    && typeof candidate.upsertSchemaCanonicalizationDelta === 'function'
    && candidate.schemaCanonicalizationCapability !== undefined;
}
