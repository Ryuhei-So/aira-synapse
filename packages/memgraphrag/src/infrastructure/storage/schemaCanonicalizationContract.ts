import { Buffer } from 'node:buffer';

import type { SchemaAlias, Schema } from '../../domain/memory/schema.js';
import {
  LANGUAGE_CODE_VALUES,
  PROVENANCE_SOURCE_VALUES,
  SCHEMA_STATE_VALUES,
  isMemoryLayer,
  type SchemaState,
} from '../../domain/memory/types.js';
import type {
  GraphUpsertWireParams,
  IndexingMemoryWireDelta,
  SchemaCanonicalizationCapability,
  SchemaCanonicalizationMemoryDelta,
  SchemaCanonicalizationMergeExisting,
  SchemaCanonicalizationProjection,
  SchemaCanonicalizationProjectionRequest,
  SchemaMergeIntent,
  SchemaNodeReference,
} from '../../domain/storage/schemaCanonicalization.js';
import {
  INDEXING_MEMORY_CONTRACT,
  type IndexingMemoryDelta,
} from '../../domain/storage/indexingMemory.js';
import {
  SCHEMA_CANONICALIZATION_CONTRACT,
} from '../../domain/storage/schemaCanonicalization.js';
import {
  assertFact,
  assertPassage,
  assertSchema,
  assertBoundedString,
  validateDelta,
} from './indexingMemoryContract.js';

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertObject(value: unknown, name: string): asserts value is JsonObject {
  if (!isObject(value)) throw new Error(`${name} must be an object`);
}

function assertOnlyKeys(value: JsonObject, allowed: readonly string[], name: string): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error(`${name} contains unsupported fields`);
  }
}

function hasOwn(value: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function assertNonnegativeInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} must be a nonnegative safe integer`);
  }
}

function assertDomainId(value: unknown, name: string): asserts value is string {
  assertBoundedString(value, name, INDEXING_MEMORY_CONTRACT.maxDomainIdBytes);
}

function assertCorpusId(value: unknown, name = 'corpusId'): asserts value is string {
  assertBoundedString(value, name, INDEXING_MEMORY_CONTRACT.maxCorpusIdBytes);
}

/** Generic GraphNode IDs use the native graph request-frame bound, not the
 * narrower schema-marker composite bound negotiated for schemaNodeRefs. */
function assertGraphNodeId(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
}

function assertUpdatedAt(value: unknown, name: string): asserts value is string {
  assertBoundedString(value, name, INDEXING_MEMORY_CONTRACT.maxUpdatedAtBytes);
}

function assertState(value: unknown, name: string): asserts value is SchemaState {
  if (typeof value !== 'string' || !SCHEMA_STATE_VALUES.includes(value as SchemaState)) {
    throw new Error(`${name} must be a supported schema state`);
  }
}

function assertLowercaseSha256(value: unknown, name: string): asserts value is string {
  if (
    typeof value !== 'string'
    || value.length !== 64
    || !/^[0-9a-f]+$/.test(value)
  ) {
    throw new Error(`${name} must be lowercase SHA-256 hex`);
  }
}

function assertExactContractNumber(
  value: unknown,
  expected: number,
  name: string,
): asserts value is number {
  assertNonnegativeInteger(value, name);
  if (value !== expected) throw new Error(`${name} is unsupported`);
}

function assertAlias(value: unknown, name: string): asserts value is SchemaAlias {
  assertObject(value, name);
  assertOnlyKeys(value, ['label', 'language', 'source', 'confidence', 'isCanonical'], name);
  assertDomainId(value.label, `${name}.label`);
  if (
    typeof value.language !== 'string'
    || !LANGUAGE_CODE_VALUES.includes(value.language as (typeof LANGUAGE_CODE_VALUES)[number])
  ) {
    throw new Error(`${name}.language is unsupported`);
  }
  if (
    typeof value.source !== 'string'
    || !PROVENANCE_SOURCE_VALUES.includes(value.source as (typeof PROVENANCE_SOURCE_VALUES)[number])
  ) {
    throw new Error(`${name}.source is unsupported`);
  }
  if (typeof value.confidence !== 'number' || !Number.isFinite(value.confidence)) {
    throw new Error(`${name}.confidence must be finite`);
  }
  if (typeof value.isCanonical !== 'boolean') {
    throw new Error(`${name}.isCanonical must be boolean`);
  }
}

function assertCanonicalSchema(
  value: unknown,
  corpusId: string,
  name: string,
): asserts value is Schema {
  // Keep the existing full-schema authority in the path.  The additional
  // checks below mirror only the native byte bounds needed by this wire lane.
  assertSchema(value, corpusId, name);
  const schema = value as Schema;
  for (const field of ['headType', 'relation', 'tailType', 'canonicalKey'] as const) {
    assertDomainId(schema[field], `${name}.${field}`);
  }
  assertUpdatedAt(schema.createdAt, `${name}.createdAt`);
  assertUpdatedAt(schema.updatedAt, `${name}.updatedAt`);
  if (!Array.isArray(schema.aliases)) throw new Error(`${name}.aliases must be an array`);
  for (const [index, alias] of schema.aliases.entries()) {
    assertAlias(alias, `${name}.aliases[${index}]`);
  }
  for (const field of ['factIds', 'sourceDocumentIds'] as const) {
    const ids = schema[field];
    if (!Array.isArray(ids)) throw new Error(`${name}.${field} must be an array`);
    for (const [index, id] of ids.entries()) {
      assertDomainId(id, `${name}.${field}[${index}]`);
    }
  }
}

function assertUniqueIds(ids: readonly string[], name: string): void {
  const seen = new Set<string>();
  for (const [index, id] of ids.entries()) {
    assertDomainId(id, `${name}[${index}]`);
    if (seen.has(id)) throw new Error(`${name} must not contain duplicate IDs`);
    seen.add(id);
  }
}

function assertCapabilityObject(
  value: unknown,
): asserts value is SchemaCanonicalizationCapability {
  assertObject(value, 'schema canonicalization capability');
  assertOnlyKeys(
    value,
    [
      'schema',
      'projection',
      'merge',
      'graphHydration',
      'maxProjectedSchemas',
      'maxSchemaMerges',
      'maxGraphHydrations',
      'maxAliasAdditions',
      'maxFactIdAdditions',
      'maxSchemaNodeIdBytes',
      'maxSchemaNodeLabelBytes',
    ],
    'schema canonicalization capability',
  );
  if (value.schema !== SCHEMA_CANONICALIZATION_CONTRACT.schema) {
    throw new Error('schema canonicalization capability.schema is unsupported');
  }
  if (value.projection !== SCHEMA_CANONICALIZATION_CONTRACT.projection) {
    throw new Error('schema canonicalization capability.projection is unsupported');
  }
  if (value.merge !== SCHEMA_CANONICALIZATION_CONTRACT.merge) {
    throw new Error('schema canonicalization capability.merge is unsupported');
  }
  if (value.graphHydration !== SCHEMA_CANONICALIZATION_CONTRACT.graphHydration) {
    throw new Error('schema canonicalization capability.graphHydration is unsupported');
  }
  for (const field of [
    'maxProjectedSchemas',
    'maxSchemaMerges',
    'maxGraphHydrations',
    'maxAliasAdditions',
    'maxFactIdAdditions',
    'maxSchemaNodeIdBytes',
    'maxSchemaNodeLabelBytes',
  ] as const) {
    assertExactContractNumber(value[field], SCHEMA_CANONICALIZATION_CONTRACT[field], field);
  }
}

export function validateSchemaCanonicalizationCapability(
  value: unknown,
): asserts value is SchemaCanonicalizationCapability {
  assertCapabilityObject(value);
}

export function validateSchemaCanonicalizationProjectionRequest(
  value: unknown,
  capability: SchemaCanonicalizationCapability = SCHEMA_CANONICALIZATION_CONTRACT,
): asserts value is SchemaCanonicalizationProjectionRequest {
  validateSchemaCanonicalizationCapability(capability);
  assertObject(value, 'schema canonicalization projection request');
  assertOnlyKeys(
    value,
    ['corpusId', 'schemaIds', 'projection', 'contributionDocumentId'],
    'schema canonicalization projection request',
  );
  assertCorpusId(value.corpusId);
  if (value.projection !== capability.projection) {
    throw new Error('schema canonicalization projection is unsupported');
  }
  if (!Array.isArray(value.schemaIds)) {
    throw new Error('schema canonicalization schemaIds must be an array');
  }
  if (value.schemaIds.length > capability.maxProjectedSchemas) {
    throw new Error('schema canonicalization schemaIds exceed the negotiated bound');
  }
  assertUniqueIds(value.schemaIds, 'schema canonicalization schemaIds');
  assertDomainId(value.contributionDocumentId, 'contributionDocumentId');
}

function assertProjectionItem(
  value: unknown,
  request: SchemaCanonicalizationProjectionRequest,
  name: string,
): asserts value is SchemaCanonicalizationProjection {
  assertObject(value, name);
  assertOnlyKeys(
    value,
    [
      'schemaId',
      'corpusId',
      'headType',
      'relation',
      'tailType',
      'canonicalKey',
      'frequency',
      'state',
      'stabilizationThreshold',
      'firstSourceDocumentId',
      'contributionPresent',
      'mergeToken',
    ],
    name,
  );
  assertDomainId(value.schemaId, `${name}.schemaId`);
  if (value.corpusId !== request.corpusId) {
    throw new Error(`${name}.corpusId must match the request`);
  }
  for (const field of ['headType', 'relation', 'tailType', 'canonicalKey'] as const) {
    assertDomainId(value[field], `${name}.${field}`);
  }
  assertNonnegativeInteger(value.frequency, `${name}.frequency`);
  assertState(value.state, `${name}.state`);
  assertNonnegativeInteger(
    value.stabilizationThreshold,
    `${name}.stabilizationThreshold`,
  );
  if (value.firstSourceDocumentId !== null) {
    assertDomainId(value.firstSourceDocumentId, `${name}.firstSourceDocumentId`);
  }
  if (typeof value.contributionPresent !== 'boolean') {
    throw new Error(`${name}.contributionPresent must be boolean`);
  }
  assertLowercaseSha256(value.mergeToken, `${name}.mergeToken`);
}

export function validateSchemaCanonicalizationProjectionResponse(
  value: unknown,
  request: SchemaCanonicalizationProjectionRequest,
  capability: SchemaCanonicalizationCapability = SCHEMA_CANONICALIZATION_CONTRACT,
): readonly SchemaCanonicalizationProjection[] {
  validateSchemaCanonicalizationProjectionRequest(request, capability);
  if (!Array.isArray(value)) {
    throw new Error('schema canonicalization projection response must be an array');
  }
  if (value.length > request.schemaIds.length) {
    throw new Error('schema canonicalization projection response exceeds the request');
  }
  const positions = new Map(request.schemaIds.map((id, index) => [id, index]));
  const seen = new Set<string>();
  let previousPosition = -1;
  for (const [index, item] of value.entries()) {
    assertProjectionItem(item, request, `schema canonicalization projection[${index}]`);
    const position = positions.get(item.schemaId);
    if (position === undefined) {
      throw new Error('schema canonicalization projection contains an unrequested schemaId');
    }
    if (seen.has(item.schemaId)) {
      throw new Error('schema canonicalization projection contains a duplicate schemaId');
    }
    seen.add(item.schemaId);
    if (position <= previousPosition) {
      throw new Error('schema canonicalization projection is not in request order');
    }
    previousPosition = position;
  }
  return value;
}

function assertDeltaSections(
  value: JsonObject,
  corpusId: string,
): void {
  for (const [section, idKey, assertItem] of [
    ['passages', 'passageId', assertPassage],
    ['facts', 'factId', assertFact],
  ] as const) {
    const items = value[section];
    if (!Array.isArray(items)) throw new Error(`${section} must be an array`);
    if (items.length > INDEXING_MEMORY_CONTRACT.maxDeltaItemsPerSection) {
      throw new Error(`${section} exceeds the indexing delta bound`);
    }
    const seen = new Set<string>();
    for (const [index, item] of items.entries()) {
      assertObject(item, `${section}[${index}]`);
      assertDomainId(item[idKey], `${section}[${index}].${idKey}`);
      if (seen.has(item[idKey])) {
        throw new Error(`${section} must not contain duplicate IDs`);
      }
      seen.add(item[idKey]);
      assertItem(item, corpusId, `${section}[${index}]`);
    }
  }
}

function assertMergeIntent(
  value: unknown,
  corpusId: string,
  name: string,
): string {
  assertObject(value, name);
  if (value.mode === 'create') {
    assertOnlyKeys(value, ['mode', 'expectedAbsent', 'schema'], name);
    if (value.expectedAbsent !== true) {
      throw new Error(`${name}.expectedAbsent must be true`);
    }
    assertCanonicalSchema(value.schema, corpusId, `${name}.schema`);
    return value.schema.schemaId;
  }
  if (value.mode !== 'merge') {
    throw new Error(`${name}.mode is unsupported`);
  }
  assertOnlyKeys(
    value,
    [
      'mode',
      'schemaId',
      'expectedMergeToken',
      'contributionDocumentId',
      'frequencyDelta',
      'desiredState',
      'stabilizationThreshold',
      'updatedAt',
      'aliasAdditions',
      'factIdAdditions',
    ],
    name,
  );
  assertDomainId(value.schemaId, `${name}.schemaId`);
  assertLowercaseSha256(value.expectedMergeToken, `${name}.expectedMergeToken`);
  assertDomainId(value.contributionDocumentId, `${name}.contributionDocumentId`);
  assertNonnegativeInteger(value.frequencyDelta, `${name}.frequencyDelta`);
  assertState(value.desiredState, `${name}.desiredState`);
  assertNonnegativeInteger(
    value.stabilizationThreshold,
    `${name}.stabilizationThreshold`,
  );
  assertUpdatedAt(value.updatedAt, `${name}.updatedAt`);
  if (!Array.isArray(value.aliasAdditions)) {
    throw new Error(`${name}.aliasAdditions must be an array`);
  }
  const aliases = new Set<string>();
  for (const [index, alias] of value.aliasAdditions.entries()) {
    assertAlias(alias, `${name}.aliasAdditions[${index}]`);
    const aliasKey = `${alias.label}\u0000${alias.language}\u0000${alias.source}`;
    if (aliases.has(aliasKey)) {
      throw new Error(`${name}.aliasAdditions must be unique`);
    }
    aliases.add(aliasKey);
  }
  if (!Array.isArray(value.factIdAdditions)) {
    throw new Error(`${name}.factIdAdditions must be an array`);
  }
  assertUniqueIds(value.factIdAdditions, `${name}.factIdAdditions`);
  return value.schemaId;
}

export function validateSchemaMergeIntents(
  value: unknown,
  corpusId: string,
  capability: SchemaCanonicalizationCapability = SCHEMA_CANONICALIZATION_CONTRACT,
): asserts value is readonly SchemaMergeIntent[] {
  validateSchemaCanonicalizationCapability(capability);
  assertCorpusId(corpusId);
  if (!Array.isArray(value)) throw new Error('schemaMerges must be an array');
  if (value.length === 0 || value.length > capability.maxSchemaMerges) {
    throw new Error('schemaMerges count is outside the negotiated bound');
  }
  const seenSchemaIds = new Set<string>();
  let aliasCount = 0;
  let factIdCount = 0;
  for (const [index, intent] of value.entries()) {
    const schemaId = assertMergeIntent(intent, corpusId, `schemaMerges[${index}]`);
    if (seenSchemaIds.has(schemaId)) {
      throw new Error('schemaMerges must not contain duplicate schemaId values');
    }
    seenSchemaIds.add(schemaId);
    if (isObject(intent) && intent.mode === 'merge') {
      const mergeIntent = intent as unknown as SchemaCanonicalizationMergeExisting;
      aliasCount += mergeIntent.aliasAdditions.length;
      factIdCount += mergeIntent.factIdAdditions.length;
    }
  }
  if (aliasCount > capability.maxAliasAdditions) {
    throw new Error('schema alias additions exceed the negotiated bound');
  }
  if (factIdCount > capability.maxFactIdAdditions) {
    throw new Error('schema fact ID additions exceed the negotiated bound');
  }
}

/**
 * Check the state-dependent rule that cannot be validated from a merge intent
 * alone: a contribution already present in the projection must carry delta 0.
 */
export function validateSchemaMergeAgainstProjection(
  projection: SchemaCanonicalizationProjection,
  intent: SchemaMergeIntent,
): void {
  if (intent.mode !== 'merge') {
    throw new Error('schema projection can only validate a merge intent');
  }
  assertProjectionItem(
    projection,
    {
      corpusId: projection.corpusId,
      schemaIds: [projection.schemaId],
      projection: SCHEMA_CANONICALIZATION_CONTRACT.projection,
      contributionDocumentId: intent.contributionDocumentId,
    },
    'schema projection',
  );
  if (projection.schemaId !== intent.schemaId) {
    throw new Error('schema merge schemaId does not match its projection');
  }
  if (projection.mergeToken !== intent.expectedMergeToken) {
    throw new Error('schema merge token does not match its projection');
  }
  if (projection.contributionPresent && intent.frequencyDelta !== 0) {
    throw new Error('existing document contribution requires frequencyDelta zero');
  }
  if (!projection.contributionPresent && intent.frequencyDelta === 0) {
    throw new Error('new document contribution requires a positive frequencyDelta');
  }
}

export function validateSchemaCanonicalizationMemoryDelta(
  value: unknown,
  capability: SchemaCanonicalizationCapability = SCHEMA_CANONICALIZATION_CONTRACT,
): asserts value is SchemaCanonicalizationMemoryDelta {
  validateSchemaCanonicalizationCapability(capability);
  assertObject(value, 'schema canonicalization memory delta');
  assertOnlyKeys(
    value,
    ['corpusId', 'passages', 'facts', 'schemaMerges', 'exportedAt'],
    'schema canonicalization memory delta',
  );
  assertCorpusId(value.corpusId);
  // Match the unchanged legacy delta envelope: an empty exportedAt is valid
  // for compatibility fixtures and carries no schema payload.
  assertBoundedString(
    value.exportedAt,
    'exportedAt',
    INDEXING_MEMORY_CONTRACT.maxUpdatedAtBytes,
    true,
  );
  assertDeltaSections(value, value.corpusId);
  validateSchemaMergeIntents(value.schemaMerges, value.corpusId, capability);

  const encoded = Buffer.from(JSON.stringify({
    id: Number.MAX_SAFE_INTEGER,
    method: 'memory_upsert',
    params: value,
  }), 'utf8');
  if (encoded.byteLength > INDEXING_MEMORY_CONTRACT.maxRequestBytes) {
    throw new Error('memory_upsert request exceeds the indexing request bound');
  }
}

/** Validate either unchanged legacy full-schema or projected canonicalization mode. */
export function validateIndexingMemoryWireDelta(
  value: unknown,
): asserts value is IndexingMemoryWireDelta {
  assertObject(value, 'indexing memory wire delta');
  const hasSchemas = hasOwn(value, 'schemas');
  const hasSchemaMerges = hasOwn(value, 'schemaMerges');
  if (hasSchemas && hasSchemaMerges) {
    throw new Error('schemas and schemaMerges are mutually exclusive');
  }
  if (hasSchemas) {
    validateDelta(value as unknown as IndexingMemoryDelta);
    return;
  }
  if (hasSchemaMerges) {
    validateSchemaCanonicalizationMemoryDelta(value);
    return;
  }
  throw new Error('indexing memory wire delta must select a mutation mode');
}

function assertNodeArray(
  value: unknown,
): void {
  if (!Array.isArray(value)) throw new Error('upsert_nodes.nodes must be an array');
  for (const [index, node] of value.entries()) {
    assertObject(node, `upsert_nodes.nodes[${index}]`);
    assertGraphNodeId(
      node.nodeId,
      `upsert_nodes.nodes[${index}].nodeId`,
    );
    assertCorpusId(node.corpusId, `upsert_nodes.nodes[${index}].corpusId`);
    if (!isMemoryLayer(node.layer)) {
      throw new Error(`upsert_nodes.nodes[${index}].layer must be a supported memory layer`);
    }
    if (!isObject(node.ref)) {
      throw new Error(`upsert_nodes.nodes[${index}].ref must be an object`);
    }
    if (typeof node.label !== 'string') {
      throw new Error(`upsert_nodes.nodes[${index}].label must be a string`);
    }
  }
}

function assertSchemaNodeReference(
  value: unknown,
  name: string,
  capability: SchemaCanonicalizationCapability,
): asserts value is SchemaNodeReference {
  assertObject(value, name);
  assertOnlyKeys(value, ['nodeId', 'corpusId', 'schemaId', 'label'], name);
  assertBoundedString(value.nodeId, `${name}.nodeId`, capability.maxSchemaNodeIdBytes);
  assertCorpusId(value.corpusId, `${name}.corpusId`);
  assertDomainId(value.schemaId, `${name}.schemaId`);
  assertBoundedString(value.label, `${name}.label`, capability.maxSchemaNodeLabelBytes);
  if (value.nodeId !== `schema:${value.schemaId}`) {
    throw new Error(`${name}.nodeId is inconsistent with schemaId`);
  }
}

export function validateGraphUpsertWireParams(
  value: unknown,
  capability: SchemaCanonicalizationCapability = SCHEMA_CANONICALIZATION_CONTRACT,
): asserts value is GraphUpsertWireParams {
  validateSchemaCanonicalizationCapability(capability);
  assertObject(value, 'upsert_nodes request');
  const hasVersion = hasOwn(value, 'schemaRefHydration');
  const hasMarkers = hasOwn(value, 'schemaNodeRefs');
  if (!hasVersion && !hasMarkers) {
    assertOnlyKeys(value, ['nodes'], 'upsert_nodes request');
    const nodes = value.nodes;
    assertNodeArray(nodes);
    return;
  }
  if (!hasVersion || !hasMarkers) {
    throw new Error('schema hydration version and markers must be supplied together');
  }
  assertOnlyKeys(value, ['nodes', 'schemaRefHydration', 'schemaNodeRefs'], 'upsert_nodes request');
  const nodes = value.nodes;
  assertNodeArray(nodes);
  if (value.schemaRefHydration !== capability.graphHydration) {
    throw new Error('schemaRefHydration is unsupported');
  }
  if (!Array.isArray(value.schemaNodeRefs)) {
    throw new Error('schemaNodeRefs must be an array');
  }
  if (
    value.schemaNodeRefs.length === 0
    || value.schemaNodeRefs.length > capability.maxGraphHydrations
  ) {
    throw new Error('schemaNodeRefs count is outside the negotiated bound');
  }
  const nodeKeys = new Set<string>();
  for (const node of nodes as readonly unknown[]) {
    if (isObject(node)) nodeKeys.add(`${node.corpusId}\u0000${node.nodeId}`);
  }
  for (const [index, marker] of value.schemaNodeRefs.entries()) {
    assertSchemaNodeReference(marker, `schemaNodeRefs[${index}]`, capability);
    const key = `${marker.corpusId}\u0000${marker.nodeId}`;
    if (nodeKeys.has(key)) {
      throw new Error('upsert_nodes contains a duplicate node identity');
    }
    nodeKeys.add(key);
  }
}
