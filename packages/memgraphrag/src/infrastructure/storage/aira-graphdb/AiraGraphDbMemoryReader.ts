import type { Fact } from '../../../domain/memory/fact.js';
import type { Passage } from '../../../domain/memory/passage.js';
import type { Schema } from '../../../domain/memory/schema.js';
import {
  MEMORY_READ_CONTRACT,
  type FactsByEntitiesRequest,
  type FactsByIdsRequest,
  type IMemoryReader,
  type MemoryReadBounds,
  type MemorySectionCounts,
  type PassagesByIdsRequest,
  type SchemasByIdsRequest,
  type SectionCountsRequest,
} from '../../../domain/storage/memoryReader.js';
import {
  FACT_SECTION,
  PASSAGE_SECTION,
  SCHEMA_SECTION,
  assertFactStateFilter,
  assertFindFactsLimit,
  assertMemoryReadCorpusId,
  chunkItems,
  mergeEntityFactChunks,
  normalizeRequestIds,
  parseMemoryReadBounds,
  validateByIdResponse,
  validateEntityFactResponse,
  validateSectionCounts,
  type MemorySectionSpec,
} from '../memoryReadContract.js';
import type {
  AiraGraphDbRpcClient,
  NativeRequestLimits,
} from './NativeClient.js';

type JsonObject = Record<string, unknown>;

const PROTOCOL_VERSION = 'native-method-policy@1';
const PROTOCOL_LIMITS: NativeRequestLimits = {
  maxRequestBytes: 1024 * 1024,
  maxResponseBytes: 1024 * 1024,
};

/**
 * Everything the reader takes from `protocol_info` at startup. The bounds
 * are the native's advertisement; nothing here is a hard-coded assumption.
 */
export interface MemoryReadCapabilities {
  readonly bounds: MemoryReadBounds;
  /** Advertised `limits.indexingMemory.maxSchemaIds`: the by-id bound of the schema read. */
  readonly maxSchemaIds: number;
  readonly maxDomainIdBytes: number;
  readonly maxCorpusIdBytes: number;
  /** Wire caps of the BoundedIndexing profile every memory read runs under. */
  readonly wire: NativeRequestLimits;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown, name: string): JsonObject {
  if (!isObject(value)) throw new Error(`${name} must be an object`);
  return value;
}

function requirePositiveSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value as number;
}

/**
 * Fail closed before any query. A native that does not advertise the memory
 * read methods (deployed binaries before aira-graphdb 83ef0eb) is rejected
 * by name; the runtime never probes by calling and never falls back to the
 * whole-corpus `memory_load`.
 */
export function validateMemoryReadProtocolInfo(value: unknown): MemoryReadCapabilities {
  const protocol = requireObject(value, 'protocol_info result');
  if (protocol.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(`unsupported aira-graphdb protocolVersion: ${String(protocol.protocolVersion)}`);
  }
  if (!Array.isArray(protocol.methods)) {
    throw new Error('protocol_info.methods must be an array');
  }
  const methods = new Map<string, JsonObject>();
  for (const [index, candidate] of protocol.methods.entries()) {
    const method = requireObject(candidate, `protocol_info.methods[${index}]`);
    if (typeof method.name !== 'string' || methods.has(method.name)) {
      throw new Error('protocol_info.methods contains an invalid or duplicate name');
    }
    methods.set(method.name, method);
  }
  for (const name of [...MEMORY_READ_CONTRACT.methods, SCHEMA_SECTION.method]) {
    const method = methods.get(name);
    if (!method) {
      throw new Error(
        `aira-graphdb native does not advertise ${name}; the query path requires `
        + `${MEMORY_READ_CONTRACT.schema} (aira-graphdb >= 83ef0eb) and does not fall back to memory_load`,
      );
    }
    if (method.classification !== 'read' || method.wal !== false) {
      throw new Error(`aira-graphdb method contract mismatch for ${name}: expected classification read, wal false`);
    }
  }

  const limits = requireObject(protocol.limits, 'protocol_info.limits');
  const bounds = parseMemoryReadBounds(limits.memoryRead);
  const indexing = requireObject(limits.indexingMemory, 'protocol_info.limits.indexingMemory');
  return Object.freeze({
    bounds,
    maxSchemaIds: requirePositiveSafeInteger(indexing.maxSchemaIds, 'protocol_info.limits.indexingMemory.maxSchemaIds'),
    maxDomainIdBytes: requirePositiveSafeInteger(indexing.maxDomainIdBytes, 'protocol_info.limits.indexingMemory.maxDomainIdBytes'),
    maxCorpusIdBytes: requirePositiveSafeInteger(indexing.maxCorpusIdBytes, 'protocol_info.limits.indexingMemory.maxCorpusIdBytes'),
    wire: Object.freeze({
      maxRequestBytes: requirePositiveSafeInteger(indexing.maxRequestBytes, 'protocol_info.limits.indexingMemory.maxRequestBytes'),
      maxResponseBytes: requirePositiveSafeInteger(indexing.maxResponseBytes, 'protocol_info.limits.indexingMemory.maxResponseBytes'),
    }),
  });
}

export class AiraGraphDbMemoryReader implements IMemoryReader {
  public readonly bounds: MemoryReadBounds;

  private constructor(
    private readonly client: AiraGraphDbRpcClient,
    private readonly capabilities: MemoryReadCapabilities,
  ) {
    this.bounds = capabilities.bounds;
  }

  public static async create(client: AiraGraphDbRpcClient): Promise<AiraGraphDbMemoryReader> {
    const protocol = await client.request<unknown>('protocol_info', {}, PROTOCOL_LIMITS);
    return new AiraGraphDbMemoryReader(client, validateMemoryReadProtocolInfo(protocol));
  }

  public getPassagesByIds(request: PassagesByIdsRequest): Promise<readonly Passage[]> {
    return this.readByIds(PASSAGE_SECTION, request.corpusId, request.passageIds, this.bounds.maxIdsPerRequest);
  }

  public getFactsByIds(request: FactsByIdsRequest): Promise<readonly Fact[]> {
    return this.readByIds(FACT_SECTION, request.corpusId, request.factIds, this.bounds.maxIdsPerRequest);
  }

  public getSchemasByIds(request: SchemasByIdsRequest): Promise<readonly Schema[]> {
    return this.readByIds(SCHEMA_SECTION, request.corpusId, request.schemaIds, this.capabilities.maxSchemaIds);
  }

  public async findFactsByEntities(request: FactsByEntitiesRequest): Promise<readonly Fact[]> {
    assertMemoryReadCorpusId(request.corpusId, this.capabilities.maxCorpusIdBytes);
    assertFactStateFilter(request.state);
    const limit = assertFindFactsLimit(request.limit, this.bounds.maxLimit);
    const entities = normalizeRequestIds(request.entities, 'entities', this.capabilities.maxDomainIdBytes);
    if (limit === 0 || entities.length === 0) return [];
    const chunks: Fact[][] = [];
    for (const chunk of chunkItems(entities, this.bounds.maxEntitiesPerRequest)) {
      const params = { corpusId: request.corpusId, entities: chunk, state: request.state, limit };
      const response = await this.client.request<unknown>('memory_find_facts_by_entities', params, this.capabilities.wire);
      chunks.push(validateEntityFactResponse(response, params, chunk));
    }
    return chunks.length === 1 ? chunks[0]! : mergeEntityFactChunks(chunks, limit);
  }

  public async sectionCounts(request: SectionCountsRequest): Promise<MemorySectionCounts> {
    assertMemoryReadCorpusId(request.corpusId, this.capabilities.maxCorpusIdBytes);
    const response = await this.client.request<unknown>(
      'memory_section_counts',
      { corpusId: request.corpusId },
      this.capabilities.wire,
    );
    return validateSectionCounts(response);
  }

  private async readByIds<TItem>(
    spec: MemorySectionSpec<TItem>,
    corpusId: string,
    requestedIds: readonly string[],
    maxIdsPerRequest: number,
  ): Promise<TItem[]> {
    assertMemoryReadCorpusId(corpusId, this.capabilities.maxCorpusIdBytes);
    const ids = normalizeRequestIds(requestedIds, spec.idsKey, this.capabilities.maxDomainIdBytes);
    const items: TItem[] = [];
    for (const chunk of chunkItems(ids, maxIdsPerRequest)) {
      const response = await this.client.request<unknown>(
        spec.method,
        { corpusId, [spec.idsKey]: chunk },
        this.capabilities.wire,
      );
      items.push(...validateByIdResponse(spec, response, corpusId, chunk));
    }
    return items;
  }
}
