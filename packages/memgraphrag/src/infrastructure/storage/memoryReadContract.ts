import { Buffer } from 'node:buffer';

import type { Fact } from '../../domain/memory/fact.js';
import type { Passage } from '../../domain/memory/passage.js';
import type { Schema } from '../../domain/memory/schema.js';
import { unicode16Lowercase } from '../../domain/text/unicode16Lowercase.js';
import {
  MEMORY_READ_CONTRACT,
  type FactsByEntitiesRequest,
  type MemoryFactStateFilter,
  type MemoryReadBounds,
  type MemorySectionCounts,
} from '../../domain/storage/memoryReader.js';
import { assertFact, assertPassage, assertSchema } from './indexingMemoryContract.js';

type JsonObject = Record<string, unknown>;

export type MemorySectionKind = 'passage' | 'fact' | 'schema';

export interface MemorySectionSpec<TItem> {
  readonly kind: MemorySectionKind;
  readonly method: string;
  readonly section: 'passages' | 'facts' | 'schemas';
  readonly idsKey: 'passageIds' | 'factIds' | 'schemaIds';
  readonly idOf: (item: TItem) => string;
  readonly assert: (value: unknown, corpusId: string, name: string) => asserts value is TItem;
}

export const PASSAGE_SECTION: MemorySectionSpec<Passage> = {
  kind: 'passage',
  method: 'memory_get_passages_by_ids',
  section: 'passages',
  idsKey: 'passageIds',
  idOf: (item) => item.passageId,
  assert: assertPassage,
};

export const FACT_SECTION: MemorySectionSpec<Fact> = {
  kind: 'fact',
  method: 'memory_get_facts_by_ids',
  section: 'facts',
  idsKey: 'factIds',
  idOf: (item) => item.factId,
  assert: assertFact,
};

export const SCHEMA_SECTION: MemorySectionSpec<Schema> = {
  kind: 'schema',
  method: 'memory_get_schemas_by_ids',
  section: 'schemas',
  idsKey: 'schemaIds',
  idOf: (item) => item.schemaId,
  assert: assertSchema,
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value as number;
}

function nonnegativeSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} must be a nonnegative safe integer`);
  }
  return value as number;
}

/**
 * The advertised `limits.memoryRead` block. Only the schema tag and the
 * presence of positive integer bounds are fixed; the values are the native's.
 */
export function parseMemoryReadBounds(value: unknown, name = 'protocol_info.limits.memoryRead'): MemoryReadBounds {
  if (!isObject(value)) {
    throw new Error(`${name} must be an object`);
  }
  if (value.schema !== MEMORY_READ_CONTRACT.schema) {
    throw new Error(`${name}.schema must be ${MEMORY_READ_CONTRACT.schema}`);
  }
  const bounds: Record<string, number> = {};
  for (const key of MEMORY_READ_CONTRACT.boundKeys) {
    bounds[key] = positiveSafeInteger(value[key], `${name}.${key}`);
  }
  return Object.freeze({
    maxIdsPerRequest: bounds.maxIdsPerRequest!,
    maxEntitiesPerRequest: bounds.maxEntitiesPerRequest!,
    maxLimit: bounds.maxLimit!,
  });
}

export function assertMemoryReadCorpusId(value: unknown, maxBytes: number): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new Error(`corpusId must be a non-empty string of at most ${maxBytes} UTF-8 bytes`);
  }
}

/**
 * Request ids as the backend will see them: strings only, first occurrence
 * of a repeated id kept, in request order. Empty ids and ids longer than the
 * domain id bound are dropped instead of sent: no stored object can carry
 * such an id, so dropping equals "not found" and keeps the request valid.
 */
export function normalizeRequestIds(ids: unknown, name: string, maxIdBytes: number): string[] {
  if (!Array.isArray(ids)) {
    throw new Error(`${name} must be an array`);
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const [index, id] of ids.entries()) {
    if (typeof id !== 'string') {
      throw new Error(`${name}[${index}] must be a string`);
    }
    if (id.length === 0 || Buffer.byteLength(id, 'utf8') > maxIdBytes || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

export function chunkItems<T>(items: readonly T[], size: number): T[][] {
  positiveSafeInteger(size, 'chunk size');
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/**
 * One by-id reply: an array no larger than the request, each item a valid
 * domain object of the requested corpus, ids unique and drawn from the
 * request, in request order.
 */
export function validateByIdResponse<TItem>(
  spec: MemorySectionSpec<TItem>,
  value: unknown,
  corpusId: string,
  requestedIds: readonly string[],
): TItem[] {
  const name = `${spec.method} response`;
  if (!Array.isArray(value) || value.length > requestedIds.length) {
    throw new Error(`${name} must be an array no larger than the request`);
  }
  const positions = new Map(requestedIds.map((id, index) => [id, index]));
  let previousPosition = -1;
  const items: TItem[] = [];
  for (const [index, item] of value.entries()) {
    spec.assert(item, corpusId, `${name}[${index}]`);
    const id = spec.idOf(item);
    const position = positions.get(id);
    if (position === undefined) {
      throw new Error(`${name} contains an unrequested ${spec.kind} id`);
    }
    if (position <= previousPosition) {
      throw new Error(`${name} is not in request order or repeats a ${spec.kind} id`);
    }
    previousPosition = position;
    items.push(item);
  }
  return items;
}

/** Code point order: the same order as the native's UTF-8 byte comparison. */
export function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (char) => char.codePointAt(0)!);
  const rightPoints = Array.from(right, (char) => char.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index]! !== rightPoints[index]!) {
      return leftPoints[index]! < rightPoints[index]! ? -1 : 1;
    }
  }
  if (leftPoints.length === rightPoints.length) return 0;
  return leftPoints.length < rightPoints.length ? -1 : 1;
}

export function foldEntity(value: string): string {
  return unicode16Lowercase(value);
}

export function assertFactStateFilter(value: unknown): asserts value is MemoryFactStateFilter {
  if (value !== 'active' && value !== 'any') {
    throw new Error('state must be "active" or "any"');
  }
}

export function assertFindFactsLimit(value: unknown, maxLimit: number): number {
  const limit = nonnegativeSafeInteger(value, 'limit');
  if (limit > maxLimit) {
    throw new Error(`limit must not exceed the advertised bound ${maxLimit}`);
  }
  return limit;
}

/**
 * One entity reply: valid facts of the corpus, unique, factId strictly
 * ascending, at most `limit`, each matching a request entity under the
 * pinned case fold and satisfying the state filter. The fold check is the
 * runtime's witness that the backend applies the same table.
 */
export function validateEntityFactResponse(
  value: unknown,
  request: FactsByEntitiesRequest,
  requestEntities: readonly string[],
): Fact[] {
  const name = 'memory_find_facts_by_entities response';
  if (!Array.isArray(value) || value.length > request.limit) {
    throw new Error(`${name} must be an array no larger than the requested limit`);
  }
  const folded = new Set(requestEntities.map(foldEntity));
  const facts: Fact[] = [];
  let previousId: string | undefined;
  for (const [index, item] of value.entries()) {
    assertFact(item, request.corpusId, `${name}[${index}]`);
    if (previousId !== undefined && compareCodePoints(previousId, item.factId) >= 0) {
      throw new Error(`${name} is not strictly ascending by factId`);
    }
    previousId = item.factId;
    if (request.state === 'active' && item.state !== 'active') {
      throw new Error(`${name} contains a non-active fact`);
    }
    if (!folded.has(foldEntity(item.headEntity)) && !folded.has(foldEntity(item.tailEntity))) {
      throw new Error(`${name} contains a fact that matches no requested entity under the pinned case fold`);
    }
    facts.push(item);
  }
  return facts;
}

/**
 * The union of per-chunk replies, re-ordered and truncated. Every fact among
 * the first `limit` by factId of the whole match set matches some chunk and
 * lies within that chunk's first `limit`, so the merged prefix equals what
 * one unchunked request would return.
 */
export function mergeEntityFactChunks(chunks: readonly (readonly Fact[])[], limit: number): Fact[] {
  const byId = new Map<string, Fact>();
  for (const chunk of chunks) {
    for (const fact of chunk) {
      if (!byId.has(fact.factId)) byId.set(fact.factId, fact);
    }
  }
  return [...byId.values()]
    .sort((left, right) => compareCodePoints(left.factId, right.factId))
    .slice(0, limit);
}

export function validateSectionCounts(value: unknown): MemorySectionCounts {
  const name = 'memory_section_counts response';
  if (!isObject(value)) {
    throw new Error(`${name} must be an object`);
  }
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'facts,passages,schemas') {
    throw new Error(`${name} must contain exactly passages, facts and schemas`);
  }
  return Object.freeze({
    passages: nonnegativeSafeInteger(value.passages, `${name}.passages`),
    facts: nonnegativeSafeInteger(value.facts, `${name}.facts`),
    schemas: nonnegativeSafeInteger(value.schemas, `${name}.schemas`),
  });
}
