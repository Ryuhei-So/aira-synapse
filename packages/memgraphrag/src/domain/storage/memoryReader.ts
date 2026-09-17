import type { Fact } from '../memory/fact.js';
import type { Passage } from '../memory/passage.js';
import type { Schema } from '../memory/schema.js';

/**
 * Query-path memory reads (literature-hub #545).
 *
 * The aira-graphdb native advertises the methods and the count bounds under
 * `protocol_info.limits.memoryRead`; the runtime reads those values at start
 * and never assumes them. The names below are the only fixed part of the
 * contract: the schema tag that must be advertised, the method names that
 * must be present, and the bound keys that must be positive integers.
 */
export const MEMORY_READ_CONTRACT = {
  schema: 'native-memory-read@1',
  methods: [
    'memory_get_passages_by_ids',
    'memory_get_facts_by_ids',
    'memory_find_facts_by_entities',
    'memory_section_counts',
  ],
  boundKeys: ['maxIdsPerRequest', 'maxEntitiesPerRequest', 'maxLimit'],
} as const;

export interface MemoryReadBounds {
  /** Largest id list one backend request accepts; larger requests are chunked. */
  readonly maxIdsPerRequest: number;
  /** Largest entity list one backend request accepts; larger requests are chunked. */
  readonly maxEntitiesPerRequest: number;
  /** Largest `limit` a findFactsByEntities request may carry. */
  readonly maxLimit: number;
}

/**
 * Bounds of the in-process snapshot-backed reader: none. It scans the
 * store's own snapshot exactly as the legacy query path did, so SQLite,
 * LadybugDB and Neo4j keep their unbounded behaviour. Only the aira-graphdb
 * reader is bounded, by the native's advertisement.
 */
export const SNAPSHOT_MEMORY_READ_BOUNDS: MemoryReadBounds = Object.freeze({
  maxIdsPerRequest: Number.MAX_SAFE_INTEGER,
  maxEntitiesPerRequest: Number.MAX_SAFE_INTEGER,
  maxLimit: Number.MAX_SAFE_INTEGER,
});

export type MemoryFactStateFilter = 'active' | 'any';

export interface PassagesByIdsRequest {
  readonly corpusId: string;
  readonly passageIds: readonly string[];
}

export interface FactsByIdsRequest {
  readonly corpusId: string;
  readonly factIds: readonly string[];
}

export interface SchemasByIdsRequest {
  readonly corpusId: string;
  readonly schemaIds: readonly string[];
}

export interface FactsByEntitiesRequest {
  readonly corpusId: string;
  /** Raw entity names; equality is decided under the pinned Unicode 16 case fold. */
  readonly entities: readonly string[];
  readonly state: MemoryFactStateFilter;
  /** Must not exceed `bounds.maxLimit`. */
  readonly limit: number;
}

export interface SectionCountsRequest {
  readonly corpusId: string;
}

export interface MemorySectionCounts {
  readonly passages: number;
  readonly facts: number;
  readonly schemas: number;
}

/**
 * Targeted, corpus-scoped reads for the query path. Every reply is bounded
 * by the request, never by the corpus size.
 *
 * By-id reads return full stored objects in request order (first occurrence
 * of a repeated id wins) and omit ids that are not stored. Requests larger
 * than the advertised bound are chunked by the implementation.
 *
 * `findFactsByEntities` returns the stored facts whose `headEntity` or
 * `tailEntity` equals one of the request entities under the Unicode 16
 * case fold pinned by `unicode16Lowercase`, filtered by `state`, ordered by
 * `factId` ascending (code point order) and truncated to `limit`. Entity
 * lists larger than the bound are chunked and the union is re-ordered and
 * truncated, so the result equals a single unchunked request.
 */
export interface IMemoryReader {
  readonly bounds: MemoryReadBounds;
  getPassagesByIds(request: PassagesByIdsRequest): Promise<readonly Passage[]>;
  getFactsByIds(request: FactsByIdsRequest): Promise<readonly Fact[]>;
  getSchemasByIds(request: SchemasByIdsRequest): Promise<readonly Schema[]>;
  findFactsByEntities(request: FactsByEntitiesRequest): Promise<readonly Fact[]>;
  sectionCounts(request: SectionCountsRequest): Promise<MemorySectionCounts>;
}
