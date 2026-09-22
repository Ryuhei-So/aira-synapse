import { describe, expect, it } from 'vitest';

import type { Schema } from '../../../../src/domain/memory/schema.js';
import {
  SCHEMA_CANONICALIZATION_CONTRACT,
  type SchemaCanonicalizationProjection,
} from '../../../../src/domain/storage/schemaCanonicalization.js';
import {
  validateGraphUpsertWireParams,
  validateIndexingMemoryWireDelta,
  validateSchemaCanonicalizationCapability,
  validateSchemaCanonicalizationMemoryDelta,
  validateSchemaCanonicalizationProjectionRequest,
  validateSchemaCanonicalizationProjectionResponse,
  validateSchemaMergeAgainstProjection,
  validateSchemaMergeIntents,
} from '../../../../src/infrastructure/storage/schemaCanonicalizationContract.js';

const NOW = '2026-09-23T00:00:00.000Z';
const TOKEN = 'a'.repeat(64);

function schema(schemaId = 'schema:a', corpusId = 'corpus-a'): Schema {
  return {
    schemaId,
    corpusId,
    headType: 'drug',
    relation: 'treats',
    tailType: 'condition',
    canonicalKey: 'drug::treats::condition',
    aliases: [{
      label: 'treats',
      language: 'en',
      source: 'manual',
      confidence: 1,
      isCanonical: true,
    }],
    frequency: 7,
    state: 'stable',
    stabilizationThreshold: 2,
    factIds: ['fact:a'],
    sourceDocumentIds: ['document-historical-first'],
    version: 4,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function request(): {
  corpusId: string;
  schemaIds: readonly string[];
  projection: 'canonicalization@1';
  contributionDocumentId: string;
} {
  return {
    corpusId: 'corpus-a',
    schemaIds: ['schema:a', 'schema:missing'],
    projection: 'canonicalization@1',
    contributionDocumentId: 'document-current',
  };
}

function projection(overrides: Partial<SchemaCanonicalizationProjection> = {}): SchemaCanonicalizationProjection {
  return {
    schemaId: 'schema:a',
    corpusId: 'corpus-a',
    headType: 'drug',
    relation: 'treats',
    tailType: 'condition',
    canonicalKey: 'drug::treats::condition',
    frequency: 7,
    state: 'stable',
    stabilizationThreshold: 2,
    firstSourceDocumentId: 'document-historical-first',
    contributionPresent: false,
    mergeToken: TOKEN,
    ...overrides,
  };
}

function mergeIntent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: 'merge',
    schemaId: 'schema:a',
    expectedMergeToken: TOKEN,
    contributionDocumentId: 'document-current',
    frequencyDelta: 3,
    desiredState: 'stable',
    stabilizationThreshold: 2,
    updatedAt: NOW,
    aliasAdditions: [],
    factIdAdditions: [],
    ...overrides,
  };
}

describe('schema canonicalization wire contract', () => {
  it('pins the exact negotiated versions, bounds, and no extra capability fields', () => {
    expect(() => validateSchemaCanonicalizationCapability(
      SCHEMA_CANONICALIZATION_CONTRACT,
    )).not.toThrow();
    expect(() => validateSchemaCanonicalizationCapability({
      ...SCHEMA_CANONICALIZATION_CONTRACT,
      maxSchemaNodeLabelBytes: SCHEMA_CANONICALIZATION_CONTRACT.maxSchemaNodeLabelBytes + 1,
    })).toThrow('unsupported');
    expect(() => validateSchemaCanonicalizationCapability({
      ...SCHEMA_CANONICALIZATION_CONTRACT,
      future: true,
    })).toThrow('unsupported fields');
  });

  it('validates exact projection keys, bounded distinct IDs, and requested order', () => {
    const validRequest = request();
    expect(() => validateSchemaCanonicalizationProjectionRequest(validRequest)).not.toThrow();
    expect(() => validateSchemaCanonicalizationProjectionResponse([
      projection(),
    ], validRequest)).not.toThrow();
    expect(() => validateSchemaCanonicalizationProjectionResponse([
      projection({ schemaId: 'schema:missing' }),
      projection(),
    ], validRequest)).toThrow('request order');
    expect(() => validateSchemaCanonicalizationProjectionRequest({
      ...validRequest,
      schemaIds: ['schema:a', 'schema:a'],
    })).toThrow('duplicate');
    expect(() => validateSchemaCanonicalizationProjectionRequest({
      ...validRequest,
      unsupported: 'request-secret',
    })).toThrow('unsupported fields');

    const responseWithSecret = {
      ...projection(),
      sourceDocumentIds: ['request-secret-must-not-be-logged'],
    };
    let error: unknown;
    try {
      validateSchemaCanonicalizationProjectionResponse([responseWithSecret], validRequest);
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).not.toContain('request-secret-must-not-be-logged');
  });

  it('keeps projected and legacy memory mutations as distinct wire modes', () => {
    const projected = {
      corpusId: 'corpus-a',
      passages: [],
      facts: [],
      schemaMerges: [mergeIntent()],
      exportedAt: NOW,
    };
    expect(() => validateSchemaCanonicalizationMemoryDelta(projected)).not.toThrow();
    expect(() => validateIndexingMemoryWireDelta(projected)).not.toThrow();
    expect(Object.prototype.hasOwnProperty.call(projected, 'schemas')).toBe(false);

    const legacy = {
      corpusId: 'corpus-a',
      passages: [],
      facts: [],
      schemas: [schema()],
      exportedAt: NOW,
    };
    expect(() => validateIndexingMemoryWireDelta(legacy)).not.toThrow();
    expect(() => validateIndexingMemoryWireDelta({
      ...projected,
      schemas: [],
    })).toThrow('mutually exclusive');
    expect(() => validateIndexingMemoryWireDelta({
      ...projected,
      schemaMerges: [],
    })).toThrow('count');
    expect(() => validateIndexingMemoryWireDelta({
      corpusId: 'corpus-a',
      passages: [],
      facts: [],
      exportedAt: NOW,
    })).toThrow('select a mutation mode');
  });

  it('validates tagged create/merge intents and cumulative additions', () => {
    const create = {
      mode: 'create' as const,
      expectedAbsent: true as const,
      schema: schema('schema:new'),
    };
    expect(() => validateSchemaMergeIntents([create, mergeIntent({
      schemaId: 'schema:a',
      aliasAdditions: [{
        label: 'handles',
        language: 'en',
        source: 'nlp',
        confidence: 0.9,
        isCanonical: false,
      }],
      factIdAdditions: ['fact:new'],
    })], 'corpus-a')).not.toThrow();
    expect(() => validateSchemaMergeIntents([{
      ...mergeIntent(),
      expectedMergeToken: TOKEN.toUpperCase(),
    }], 'corpus-a')).toThrow('lowercase');
    expect(() => validateSchemaMergeIntents([{
      ...create,
      expectedAbsent: false,
    }], 'corpus-a')).toThrow('expectedAbsent');
    expect(() => validateSchemaMergeIntents([mergeIntent({
      aliasAdditions: Array.from({ length: 4097 }, (_, index) => ({
        label: `alias-${index}`,
        language: 'en',
        source: 'nlp',
        confidence: 0.5,
        isCanonical: false,
      })),
    })], 'corpus-a')).toThrow('negotiated bound');
  });

  it('enforces zero frequency delta for an already-seen contribution', () => {
    const existing = projection({ contributionPresent: true });
    expect(() => validateSchemaMergeAgainstProjection(existing, mergeIntent({
      frequencyDelta: 0,
    }) as never)).not.toThrow();
    expect(() => validateSchemaMergeAgainstProjection(existing, mergeIntent() as never))
      .toThrow('frequencyDelta zero');
    expect(() => validateSchemaMergeAgainstProjection(
      projection(),
      mergeIntent({ expectedMergeToken: 'b'.repeat(64) }) as never,
    )).toThrow('token');
  });

  it('keeps hydration markers bounded without materializing a fake full Schema', () => {
    expect(() => validateGraphUpsertWireParams({ nodes: [] })).not.toThrow();
    const schemaId = 's'.repeat(4096);
    const marker = {
      nodeId: `schema:${schemaId}`,
      corpusId: 'corpus-a',
      schemaId,
      label: `${'h'.repeat(4096)} ${'r'.repeat(4096)} ${'t'.repeat(4096)}`,
    };
    const hydrated = {
      nodes: [],
      schemaRefHydration: 'memory-schema@1',
      schemaNodeRefs: [marker],
    };
    expect(() => validateGraphUpsertWireParams(hydrated)).not.toThrow();
    expect(() => validateGraphUpsertWireParams({
      ...hydrated,
      nodes: [{ nodeId: marker.nodeId, corpusId: marker.corpusId }],
    })).toThrow('duplicate node identity');
    expect(() => validateGraphUpsertWireParams({
      ...hydrated,
      schemaNodeRefs: [{ ...marker, label: `${marker.label}x` }],
    })).toThrow('bytes');
    expect(() => validateGraphUpsertWireParams({
      ...hydrated,
      schemaNodeRefs: [{ ...marker, nodeId: 'wrong-node-id' }],
    })).toThrow('inconsistent');
  });
});
