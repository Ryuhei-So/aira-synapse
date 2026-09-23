import type {
  SchemaCanonicalizationCapability,
  SchemaCanonicalizationMemoryDelta,
  SchemaMergeIntent,
} from '../../../domain/storage/schemaCanonicalization.js';
import { INDEXING_MEMORY_CONTRACT } from '../../../domain/storage/indexingMemory.js';
import {
  validateSchemaCanonicalizationCapability,
  validateSchemaCanonicalizationMemoryDelta,
} from '../schemaCanonicalizationContract.js';

function schemaIdForIntent(intent: SchemaMergeIntent): string {
  return intent.mode === 'create' ? intent.schema.schemaId : intent.schemaId;
}

function wireDelta(
  source: SchemaCanonicalizationMemoryDelta,
  schemaMerges: readonly SchemaMergeIntent[],
  includeDocumentSections: boolean,
): SchemaCanonicalizationMemoryDelta {
  return {
    ...source,
    corpusId: source.corpusId,
    passages: includeDocumentSections ? source.passages : [],
    facts: includeDocumentSections ? source.facts : [],
    schemaMerges,
    exportedAt: source.exportedAt,
  };
}

function freezeTree<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) freezeTree(child);
  return value;
}

function immutableWireSnapshot(
  delta: SchemaCanonicalizationMemoryDelta,
  capability: SchemaCanonicalizationCapability,
): SchemaCanonicalizationMemoryDelta {
  const snapshot = JSON.parse(JSON.stringify(delta)) as SchemaCanonicalizationMemoryDelta;
  validateSchemaCanonicalizationMemoryDelta(snapshot, capability);
  return freezeTree(snapshot);
}

/**
 * Split one complete projected document delta into immutable, strict native
 * requests. The raw wire validator remains the authority for every chunk.
 */
export function planSchemaCanonicalizationMemoryBatches(
  delta: SchemaCanonicalizationMemoryDelta,
  capability: SchemaCanonicalizationCapability,
): readonly SchemaCanonicalizationMemoryDelta[] {
  validateSchemaCanonicalizationCapability(capability);
  if (!Array.isArray(delta.schemaMerges)) {
    throw new Error('schemaMerges must be an array');
  }
  if (delta.schemaMerges.length === 0) {
    throw new Error('schemaMerges must be an array with at least one intent');
  }
  if (delta.schemaMerges.length > INDEXING_MEMORY_CONTRACT.maxSchemaIds) {
    throw new Error('schemaMerges exceed the document schema bound');
  }

  // Validate the full passage/fact aggregate and every merge before planning
  // chunks. The ordinary wire authority checks all corpus, identity, domain,
  // and shape invariants; only the strict per-request merge count differs.
  const aggregateSchemaIds = new Set<string>();
  for (const [index, intent] of delta.schemaMerges.entries()) {
    validateSchemaCanonicalizationMemoryDelta(
      wireDelta(delta, [intent], index === 0),
      capability,
    );
    const schemaId = schemaIdForIntent(intent);
    if (aggregateSchemaIds.has(schemaId)) {
      throw new Error('schemaMerges must not contain duplicate schemaId values');
    }
    aggregateSchemaIds.add(schemaId);
  }

  const batches: SchemaCanonicalizationMemoryDelta[] = [];
  let current: SchemaMergeIntent[] = [];

  const validateCandidate = (intents: readonly SchemaMergeIntent[], first: boolean): void => {
    validateSchemaCanonicalizationMemoryDelta(
      wireDelta(delta, intents, first),
      capability,
    );
  };
  const finalize = (intents: readonly SchemaMergeIntent[], first: boolean): void => {
    const candidate = wireDelta(delta, intents, first);
    validateSchemaCanonicalizationMemoryDelta(candidate, capability);
    batches.push(immutableWireSnapshot(candidate, capability));
  };

  for (const intent of delta.schemaMerges) {
    const candidate = [...current, intent];
    const isFirstBatch = batches.length === 0;
    try {
      validateCandidate(candidate, isFirstBatch);
      current = candidate;
    } catch (error) {
      if (current.length === 0) throw error;

      finalize(current, isFirstBatch);
      current = [];
      const nextBatch = [intent];
      validateCandidate(nextBatch, false);
      current = nextBatch;
    }
  }

  if (current.length > 0) {
    finalize(current, batches.length === 0);
  }
  return Object.freeze(batches);
}
