import type { Fact } from '../../domain/memory/fact.js';
import type { Passage } from '../../domain/memory/passage.js';
import type { Schema } from '../../domain/memory/schema.js';
import type { IMemoryStore } from '../../domain/storage/graphStore.js';
import {
  INDEXING_MEMORY_CONTRACT,
} from '../../domain/storage/indexingMemory.js';
import {
  SNAPSHOT_MEMORY_READ_BOUNDS,
  type FactsByEntitiesRequest,
  type FactsByIdsRequest,
  type IMemoryReader,
  type MemoryReadBounds,
  type MemorySectionCounts,
  type PassagesByIdsRequest,
  type SchemasByIdsRequest,
  type SectionCountsRequest,
} from '../../domain/storage/memoryReader.js';
import {
  assertFactStateFilter,
  assertFindFactsLimit,
  assertMemoryReadCorpusId,
  compareCodePoints,
  foldEntity,
  normalizeRequestIds,
} from './memoryReadContract.js';

/**
 * IMemoryReader over a whole-snapshot IMemoryStore (SQLite, LadybugDB,
 * Neo4j). The snapshot is the store's own cached view; this class only
 * applies the port's request/reply semantics on top of it so every backend
 * answers the query path identically.
 */
export class SnapshotBackedMemoryReader implements IMemoryReader {
  public readonly bounds: MemoryReadBounds = SNAPSHOT_MEMORY_READ_BOUNDS;

  public constructor(private readonly store: IMemoryStore) {}

  public async getPassagesByIds(request: PassagesByIdsRequest): Promise<readonly Passage[]> {
    assertMemoryReadCorpusId(request.corpusId, INDEXING_MEMORY_CONTRACT.maxCorpusIdBytes);
    const ids = normalizeRequestIds(request.passageIds, 'passageIds', INDEXING_MEMORY_CONTRACT.maxDomainIdBytes);
    if (ids.length === 0) return [];
    const snapshot = await this.store.load(request.corpusId);
    return pickByIds(snapshot.passages, (item) => item.passageId, ids);
  }

  public async getFactsByIds(request: FactsByIdsRequest): Promise<readonly Fact[]> {
    assertMemoryReadCorpusId(request.corpusId, INDEXING_MEMORY_CONTRACT.maxCorpusIdBytes);
    const ids = normalizeRequestIds(request.factIds, 'factIds', INDEXING_MEMORY_CONTRACT.maxDomainIdBytes);
    if (ids.length === 0) return [];
    const snapshot = await this.store.load(request.corpusId);
    return pickByIds(snapshot.facts, (item) => item.factId, ids);
  }

  public async getSchemasByIds(request: SchemasByIdsRequest): Promise<readonly Schema[]> {
    assertMemoryReadCorpusId(request.corpusId, INDEXING_MEMORY_CONTRACT.maxCorpusIdBytes);
    const ids = normalizeRequestIds(request.schemaIds, 'schemaIds', INDEXING_MEMORY_CONTRACT.maxDomainIdBytes);
    if (ids.length === 0) return [];
    const snapshot = await this.store.load(request.corpusId);
    return pickByIds(snapshot.schemas, (item) => item.schemaId, ids);
  }

  public async findFactsByEntities(request: FactsByEntitiesRequest): Promise<readonly Fact[]> {
    assertMemoryReadCorpusId(request.corpusId, INDEXING_MEMORY_CONTRACT.maxCorpusIdBytes);
    assertFactStateFilter(request.state);
    const limit = assertFindFactsLimit(request.limit, this.bounds.maxLimit);
    const entities = normalizeRequestIds(request.entities, 'entities', INDEXING_MEMORY_CONTRACT.maxDomainIdBytes);
    if (limit === 0 || entities.length === 0) return [];
    const folded = new Set(entities.map(foldEntity));
    const snapshot = await this.store.load(request.corpusId);
    return snapshot.facts
      .filter((fact) => (request.state === 'any' || fact.state === 'active')
        && (folded.has(foldEntity(fact.headEntity)) || folded.has(foldEntity(fact.tailEntity))))
      .sort((left, right) => compareCodePoints(left.factId, right.factId))
      .slice(0, limit);
  }

  public async sectionCounts(request: SectionCountsRequest): Promise<MemorySectionCounts> {
    assertMemoryReadCorpusId(request.corpusId, INDEXING_MEMORY_CONTRACT.maxCorpusIdBytes);
    const snapshot = await this.store.load(request.corpusId);
    return {
      passages: snapshot.passages.length,
      facts: snapshot.facts.length,
      schemas: snapshot.schemas.length,
    };
  }
}

function pickByIds<T>(items: readonly T[], idOf: (item: T) => string, ids: readonly string[]): T[] {
  const wanted = new Set(ids);
  // Last stored occurrence wins, exactly as the legacy `new Map(items)` lookup did.
  const found = new Map<string, T>();
  for (const item of items) {
    const id = idOf(item);
    if (wanted.has(id)) found.set(id, item);
  }
  return ids.flatMap((id) => {
    const item = found.get(id);
    return item === undefined ? [] : [item];
  });
}
