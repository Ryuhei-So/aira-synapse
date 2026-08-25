import { Buffer } from 'node:buffer';

import { validateDomainObject } from '../../domain/memory/domainContract.js';
import type { Fact } from '../../domain/memory/fact.js';
import type { Passage } from '../../domain/memory/passage.js';
import type { Schema } from '../../domain/memory/schema.js';
import {
  INDEXING_MEMORY_CONTRACT,
  type ActivateFactsRequest,
  type ActiveFactRequest,
  type IndexingMemoryDelta,
  type IndexingMemoryMutationPlan,
  type IndexingSchemaRequest,
} from '../../domain/storage/indexingMemory.js';

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertObject(value: unknown, name: string): asserts value is JsonObject {
  if (!isObject(value)) {
    throw new Error(`${name} must be an object`);
  }
}

function assertOnlyKeys(value: JsonObject, allowed: readonly string[], name: string): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unexpected.length > 0) {
    throw new Error(`${name} contains unsupported fields: ${unexpected.join(', ')}`);
  }
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

export function assertBoundedString(
  value: unknown,
  name: string,
  maximumBytes: number,
  allowEmpty = false,
): asserts value is string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new Error(`${name} must be ${allowEmpty ? 'a string' : 'a non-empty string'}`);
  }
  if (utf8Bytes(value) > maximumBytes) {
    throw new Error(`${name} exceeds ${maximumBytes} UTF-8 bytes`);
  }
}

function assertNonnegativeInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} must be a nonnegative safe integer`);
  }
}

function assertCorpusId(corpusId: unknown, name = 'corpusId'): asserts corpusId is string {
  assertBoundedString(corpusId, name, INDEXING_MEMORY_CONTRACT.maxCorpusIdBytes);
}

function assertDomainId(value: unknown, name: string): asserts value is string {
  assertBoundedString(value, name, INDEXING_MEMORY_CONTRACT.maxDomainIdBytes);
}

function assertUniqueIds(ids: readonly string[], name: string, allowEmpty: boolean): void {
  if (!allowEmpty && ids.length === 0) {
    throw new Error(`${name} must not be empty`);
  }
  const seen = new Set<string>();
  for (const [index, id] of ids.entries()) {
    assertDomainId(id, `${name}[${index}]`);
    if (seen.has(id)) {
      throw new Error(`${name} must not contain duplicate IDs`);
    }
    seen.add(id);
  }
}

function assertCorpus(value: unknown, corpusId: string, name: string): void {
  if (value !== corpusId) {
    throw new Error(`${name}.corpusId must match the requested corpus`);
  }
}

function assertSharedDomainShape(
  kind: 'passage' | 'fact' | 'schema',
  value: unknown,
  name: string,
): void {
  const validation = validateDomainObject(kind, value);
  if (!validation.valid) {
    throw new Error(`${name} violates the Synapse domain contract: ${validation.errors.join('; ')}`);
  }
}

export function assertSchema(value: unknown, corpusId: string, name: string): asserts value is Schema {
  assertSharedDomainShape('schema', value, name);
  const schema = value as Schema;
  assertDomainId(schema.schemaId, `${name}.schemaId`);
  assertCorpus(schema.corpusId, corpusId, name);
  assertNonnegativeInteger(schema.frequency, `${name}.frequency`);
  assertNonnegativeInteger(schema.stabilizationThreshold, `${name}.stabilizationThreshold`);
  assertNonnegativeInteger(schema.version, `${name}.version`);
}

export function assertFact(value: unknown, corpusId: string, name: string): asserts value is Fact {
  assertSharedDomainShape('fact', value, name);
  const fact = value as Fact;
  assertDomainId(fact.factId, `${name}.factId`);
  assertCorpus(fact.corpusId, corpusId, name);
  assertDomainId(fact.schemaId, `${name}.schemaId`);
  if (fact.granularityParentFactId !== undefined) {
    assertDomainId(fact.granularityParentFactId, `${name}.granularityParentFactId`);
  }
}

function assertPassage(value: unknown, corpusId: string, name: string): asserts value is Passage {
  assertSharedDomainShape('passage', value, name);
  const passage = value as Passage;
  assertDomainId(passage.passageId, `${name}.passageId`);
  assertCorpus(passage.corpusId, corpusId, name);
  for (const field of ['chunkIndex', 'offsetStart', 'offsetEnd'] as const) {
    assertNonnegativeInteger(passage.metadata[field], `${name}.metadata.${field}`);
  }
  if (passage.metadata.offsetEnd <= passage.metadata.offsetStart) {
    throw new Error(`${name}.metadata offsets must describe a non-empty range`);
  }
}

export function validateSchemaRequest(request: IndexingSchemaRequest): void {
  assertObject(request, 'schema request');
  assertOnlyKeys(request, ['corpusId', 'schemaIds'], 'schema request');
  assertCorpusId(request.corpusId);
  if (!Array.isArray(request.schemaIds)) {
    throw new Error('schemaIds must be an array');
  }
  if (request.schemaIds.length > INDEXING_MEMORY_CONTRACT.maxSchemaIds) {
    throw new Error(`schemaIds must not exceed ${INDEXING_MEMORY_CONTRACT.maxSchemaIds} items`);
  }
  assertUniqueIds(request.schemaIds, 'schemaIds', true);
}

export function validateActiveFactRequest(request: ActiveFactRequest): void {
  assertObject(request, 'active fact request');
  assertOnlyKeys(request, ['corpusId', 'limit'], 'active fact request');
  assertCorpusId(request.corpusId);
  assertNonnegativeInteger(request.limit, 'limit');
  if (request.limit > INDEXING_MEMORY_CONTRACT.maxActiveFacts) {
    throw new Error(`limit must not exceed ${INDEXING_MEMORY_CONTRACT.maxActiveFacts}`);
  }
}

export function validateActivationRequest(request: ActivateFactsRequest): void {
  assertObject(request, 'activation request');
  assertOnlyKeys(request, ['corpusId', 'schemaIds', 'updatedAt'], 'activation request');
  assertCorpusId(request.corpusId);
  if (!Array.isArray(request.schemaIds)) {
    throw new Error('schemaIds must be an array');
  }
  if (request.schemaIds.length > INDEXING_MEMORY_CONTRACT.maxSchemaIds) {
    throw new Error(`schemaIds must not exceed ${INDEXING_MEMORY_CONTRACT.maxSchemaIds} items`);
  }
  assertUniqueIds(request.schemaIds, 'schemaIds', false);
  assertBoundedString(
    request.updatedAt,
    'updatedAt',
    INDEXING_MEMORY_CONTRACT.maxUpdatedAtBytes,
  );
}

export function validateDelta(delta: IndexingMemoryDelta): void {
  assertObject(delta, 'memory delta');
  assertOnlyKeys(
    delta,
    ['corpusId', 'passages', 'facts', 'schemas', 'exportedAt'],
    'memory delta',
  );
  assertCorpusId(delta.corpusId);
  assertBoundedString(
    delta.exportedAt,
    'exportedAt',
    INDEXING_MEMORY_CONTRACT.maxUpdatedAtBytes,
    true,
  );

  for (const [section, idKey] of [
    ['passages', 'passageId'],
    ['facts', 'factId'],
    ['schemas', 'schemaId'],
  ] as const) {
    const items = delta[section];
    if (!Array.isArray(items)) {
      throw new Error(`${section} must be an array`);
    }
    if (items.length > INDEXING_MEMORY_CONTRACT.maxDeltaItemsPerSection) {
      throw new Error(`${section} must not exceed ${INDEXING_MEMORY_CONTRACT.maxDeltaItemsPerSection} items`);
    }
    const seen = new Set<string>();
    for (const [index, item] of items.entries()) {
      assertObject(item, `${section}[${index}]`);
      assertDomainId(item[idKey], `${section}[${index}].${idKey}`);
      assertCorpus(item.corpusId, delta.corpusId, `${section}[${index}]`);
      if (seen.has(item[idKey])) {
        throw new Error(`${section} must not contain duplicate ${idKey} values`);
      }
      seen.add(item[idKey]);
      if (section === 'facts') {
        assertFact(item, delta.corpusId, `${section}[${index}]`);
      } else if (section === 'schemas') {
        assertSchema(item, delta.corpusId, `${section}[${index}]`);
      } else {
        assertPassage(item, delta.corpusId, `${section}[${index}]`);
      }
    }
  }
}

function assertMutationRequestFits(method: string, params: unknown): void {
  // The longest valid request ID makes this conservative for every later
  // NativeClient allocation while preserving the exact GraphDB frame cap.
  const encoded = Buffer.from(JSON.stringify({
    id: Number.MAX_SAFE_INTEGER,
    method,
    params,
  }), 'utf8');
  if (encoded.byteLength > INDEXING_MEMORY_CONTRACT.maxRequestBytes) {
    throw new Error(
      `${method} request exceeds ${INDEXING_MEMORY_CONTRACT.maxRequestBytes} bytes`,
    );
  }
}

/** Shared pure authority for the complete plan before the first WAL call. */
export function validateMutationPlan(plan: IndexingMemoryMutationPlan): void {
  assertObject(plan, 'memory mutation plan');
  assertOnlyKeys(plan, ['delta', 'activation'], 'memory mutation plan');
  validateDelta(plan.delta);
  assertMutationRequestFits('memory_upsert', plan.delta);
  if (plan.activation !== undefined) {
    validateActivationRequest(plan.activation);
    if (plan.activation.corpusId !== plan.delta.corpusId) {
      throw new Error('activation corpusId must match the delta corpusId');
    }
    assertMutationRequestFits('memory_activate_facts_by_schema_ids', plan.activation);
  }
}

export function validateSchemaResponse(
  value: unknown,
  request: IndexingSchemaRequest,
): readonly Schema[] {
  if (!Array.isArray(value) || value.length > request.schemaIds.length) {
    throw new Error('schema response must be an array no larger than the request');
  }
  const positions = new Map(request.schemaIds.map((id, index) => [id, index]));
  const seen = new Set<string>();
  let previousPosition = -1;
  for (const [index, schema] of value.entries()) {
    assertSchema(schema, request.corpusId, `schema response[${index}]`);
    const position = positions.get(schema.schemaId);
    if (position === undefined) {
      throw new Error('schema response contains an unrequested schemaId');
    }
    if (seen.has(schema.schemaId)) {
      throw new Error('schema response contains a duplicate schemaId');
    }
    if (position <= previousPosition) {
      throw new Error('schema response is not in request order');
    }
    seen.add(schema.schemaId);
    previousPosition = position;
  }
  return value;
}

export function validateActiveFactResponse(
  value: unknown,
  request: ActiveFactRequest,
): readonly Fact[] {
  if (!Array.isArray(value) || value.length > request.limit) {
    throw new Error('active fact response must be an array no larger than the requested limit');
  }
  const seen = new Set<string>();
  for (const [index, fact] of value.entries()) {
    assertFact(fact, request.corpusId, `active fact response[${index}]`);
    if (fact.state !== 'active') {
      throw new Error('active fact response contains a non-active fact');
    }
    if (seen.has(fact.factId)) {
      throw new Error('active fact response contains a duplicate factId');
    }
    seen.add(fact.factId);
  }
  return value;
}

export function validateActivatedResult(value: unknown): number {
  assertObject(value, 'activation response');
  if (Object.keys(value).length !== 1) {
    throw new Error('activation response must contain only activated');
  }
  assertNonnegativeInteger(value.activated, 'activation response.activated');
  return value.activated;
}
