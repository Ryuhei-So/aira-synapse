import type { CompositeExtractionRecord, ISchemaCanonicalizer } from '../../domain/agent/index.js';
import { computeCanonicalKey, type Schema } from '../../domain/memory/schema.js';
import type { SchemaState } from '../../domain/memory/types.js';
import type { MemorySnapshot } from '../../domain/memory/globalMemory.js';
import {
  INDEXING_MEMORY_CONTRACT,
  type IIndexingMemory,
  type ISchemaCanonicalizationMemory,
  type SchemaCanonicalizationMergeExisting,
  type SchemaCanonicalizationProjection,
  type SchemaMergeIntent,
  isSchemaCanonicalizationMemory,
} from '../../domain/storage/index.js';

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function uniqueAliases<T>(values: readonly T[], keyOf: (value: T) => string): readonly T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    const key = keyOf(value);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
  }
  return result;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * The scalar schema view consumed by fact planning and graph labels.  It is
 * deliberately smaller than Schema so the projected native response cannot
 * be mistaken for a persisted full schema.
 */
export interface SchemaPlanningView {
  readonly schemaId: string;
  readonly corpusId: string;
  readonly headType: string;
  readonly relation: string;
  readonly tailType: string;
  readonly canonicalKey: string;
  readonly frequency: number;
  readonly state: SchemaState;
  readonly stabilizationThreshold: number;
}

export interface PreparedSchemaView extends SchemaPlanningView {
  readonly firstSourceDocumentId: string | null;
  readonly contributionPresent: boolean;
  readonly isNew: boolean;
  readonly mergeToken?: string;
}

export interface CanonicalSchemaPreparation {
  readonly schemaViews: readonly PreparedSchemaView[];
  readonly mergeIntents: readonly SchemaMergeIntent[];
  readonly newlyStableSchemaIds: readonly string[];
}

interface CandidateSchemaGroup {
  readonly schema: Schema;
  readonly frequency: number;
  readonly aliases: Schema['aliases'];
  readonly sourceDocumentIds: readonly string[];
}

function aliasKey(alias: Schema['aliases'][number]): string {
  return `${alias.label}\u0000${alias.language}\u0000${alias.source}`;
}

function groupCandidateSchemas(schemas: readonly Schema[]): readonly CandidateSchemaGroup[] {
  const grouped = new Map<string, {
    schema: Schema;
    frequency: number;
    aliases: Schema['aliases'][number][];
    sourceDocumentIds: string[];
  }>();
  for (const schema of schemas) {
    const current = grouped.get(schema.schemaId);
    if (!current) {
      grouped.set(schema.schemaId, {
        schema,
        frequency: schema.frequency,
        aliases: [...schema.aliases],
        sourceDocumentIds: [...schema.sourceDocumentIds],
      });
      continue;
    }
    if (current.schema.corpusId !== schema.corpusId
      || current.schema.headType !== schema.headType
      || current.schema.relation !== schema.relation
      || current.schema.tailType !== schema.tailType
      || current.schema.canonicalKey !== schema.canonicalKey) {
      throw new Error('candidate schemas identify inconsistent schema meaning');
    }
    current.frequency += schema.frequency;
    const knownAliases = new Set(current.aliases.map(aliasKey));
    for (const alias of schema.aliases) {
      if (!knownAliases.has(aliasKey(alias))) {
        current.aliases.push(alias);
        knownAliases.add(aliasKey(alias));
      }
    }
    current.sourceDocumentIds = [...uniqueStrings([
      ...current.sourceDocumentIds,
      ...schema.sourceDocumentIds,
    ])];
  }
  return [...grouped.values()].map((group) => ({
    schema: group.schema,
    frequency: group.frequency,
    aliases: group.aliases,
    sourceDocumentIds: group.sourceDocumentIds,
  }));
}

function desiredSchemaState(
  current: SchemaState,
  frequency: number,
  threshold: number,
): SchemaState {
  return current === 'stable' || frequency >= threshold ? 'stable' : 'pending';
}

function requireCanonicalMemory(
  indexingMemory: IIndexingMemory,
): ISchemaCanonicalizationMemory {
  if (!isSchemaCanonicalizationMemory(indexingMemory)) {
    throw new Error('schema canonicalization memory capability is unavailable');
  }
  return indexingMemory;
}

function validateProjectionMerge(
  projection: SchemaCanonicalizationProjection,
  intent: SchemaCanonicalizationMergeExisting,
): void {
  if (projection.schemaId !== intent.schemaId) {
    throw new Error('schema merge projection identity is inconsistent');
  }
  if (projection.mergeToken !== intent.expectedMergeToken) {
    throw new Error('schema merge projection token is inconsistent');
  }
  if (projection.contributionPresent && intent.frequencyDelta !== 0) {
    throw new Error('existing document contribution requires frequencyDelta zero');
  }
  if (!projection.contributionPresent && intent.frequencyDelta === 0) {
    throw new Error('new document contribution requires a positive frequencyDelta');
  }
}

export class StageIICanonicalizer {
  public constructor(
    private readonly corpusId: string,
    private readonly indexingMemory: IIndexingMemory,
  ) {}

  public async canonicalizeSchemas(
    records: readonly CompositeExtractionRecord[],
    canonicalizer: ISchemaCanonicalizer,
  ): Promise<readonly Schema[]> {
    const schemas: Schema[] = [];

    for (const record of records) {
      for (const candidate of record.candidateSchemas) {
        const canonical = await canonicalizer.canonicalize(candidate);
        const canonicalKey = computeCanonicalKey(
          canonical.canonicalHeadType,
          canonical.canonicalRelation,
          canonical.canonicalTailType,
        );
        const timestamp = nowIso();

        schemas.push({
          schemaId: canonical.mergedIntoSchemaId ?? `schema:${canonicalKey}`,
          corpusId: record.chunk.corpusId,
          headType: canonical.canonicalHeadType,
          relation: canonical.canonicalRelation,
          tailType: canonical.canonicalTailType,
          canonicalKey,
          aliases: canonical.aliases,
          frequency: 1,
          state: 'pending',
          stabilizationThreshold: 2,
          factIds: [],
          sourceDocumentIds: [record.chunk.documentId],
          version: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      }
    }

    return schemas;
  }

  public async prepareSchemas(
    schemas: readonly Schema[],
    threshold = 2,
  ): Promise<{
    readonly finalSchemas: readonly Schema[];
    readonly newlyStableSchemaIds: readonly string[];
  }> {
    const schemaIds = uniqueStrings(schemas.map((schema) => schema.schemaId));
    const stored = await this.indexingMemory.getSchemasByIds({
      corpusId: this.corpusId,
      schemaIds,
    });
    const merged = new Map(stored.map((schema) => [schema.schemaId, schema]));

    for (const schema of schemas) {
      const current = merged.get(schema.schemaId);
      if (current) {
        merged.set(schema.schemaId, {
          ...current,
          frequency: current.frequency + schema.frequency,
          aliases: uniqueAliases(
            [...current.aliases, ...schema.aliases],
            (alias) => `${alias.label}:${alias.language}:${alias.source}`,
          ),
          sourceDocumentIds: uniqueStrings([
            ...current.sourceDocumentIds,
            ...schema.sourceDocumentIds,
          ]),
          updatedAt: nowIso(),
        });
      } else {
        merged.set(schema.schemaId, schema);
      }
    }

    const newlyStableSchemaIds: string[] = [];
    const finalSchemas = schemaIds.map((schemaId) => {
      const schema = merged.get(schemaId);
      if (!schema) {
        throw new Error(`prepared schema ${schemaId} is missing`);
      }
      if (schema.frequency >= threshold && schema.state !== 'stable') {
        newlyStableSchemaIds.push(schema.schemaId);
        return {
          ...schema,
          state: 'stable' as const,
          stabilizationThreshold: threshold,
          updatedAt: nowIso(),
        };
      }
      return schema;
    });
    return { finalSchemas, newlyStableSchemaIds };
  }

  /**
   * Prepare a bounded projected read and tagged CAS intents.  No storage
   * mutation happens here; callers must complete all deterministic validation
   * and provider work before submitting the returned delta.
   */
  public async prepareCanonicalSchemas(
    schemas: readonly Schema[],
    contributionDocumentId: string,
    threshold = 2,
  ): Promise<CanonicalSchemaPreparation> {
    const memory = requireCanonicalMemory(this.indexingMemory);
    const groups = groupCandidateSchemas(schemas);
    const schemaIds = groups.map((group) => group.schema.schemaId);
    if (schemaIds.length !== new Set(schemaIds).size) {
      throw new Error('canonical schema IDs must be unique');
    }
    if (schemaIds.length > INDEXING_MEMORY_CONTRACT.maxSchemaIds) {
      throw new Error('canonical schema count exceeds the indexing bound');
    }
    const capability = memory.schemaCanonicalizationCapability;
    if (!capability) {
      throw new Error('schema canonicalization projection capability is unavailable');
    }
    const maxProjectedSchemas = capability.maxProjectedSchemas;
    if (!Number.isSafeInteger(maxProjectedSchemas) || maxProjectedSchemas <= 0) {
      throw new Error('schema canonicalization projection bound is invalid');
    }
    const projections: SchemaCanonicalizationProjection[] = [];
    for (let offset = 0; offset < schemaIds.length; offset += maxProjectedSchemas) {
      const batchSchemaIds = schemaIds.slice(offset, offset + maxProjectedSchemas);
      const batchProjections = await memory.getSchemaCanonicalizationProjection({
        corpusId: this.corpusId,
        schemaIds: batchSchemaIds,
        projection: capability.projection,
        contributionDocumentId,
      });
      projections.push(...batchProjections);
    }
    const bySchemaId = new Map(projections.map((projection) => [projection.schemaId, projection]));
    const schemaViews: PreparedSchemaView[] = [];
    const mergeIntents: SchemaMergeIntent[] = [];
    const newlyStableSchemaIds: string[] = [];

    for (const group of groups) {
      const projection = bySchemaId.get(group.schema.schemaId);
      if (!projection) {
        const timestamp = nowIso();
        const state = group.frequency >= threshold ? 'stable' : 'pending';
        const createdSchema: Schema = {
          ...group.schema,
          aliases: group.aliases,
          frequency: group.frequency,
          state,
          stabilizationThreshold: threshold,
          factIds: [],
          sourceDocumentIds: uniqueStrings(group.sourceDocumentIds),
          version: 1,
          createdAt: group.schema.createdAt || timestamp,
          updatedAt: timestamp,
        };
        mergeIntents.push({
          mode: 'create',
          expectedAbsent: true,
          schema: createdSchema,
        });
        schemaViews.push({
          schemaId: createdSchema.schemaId,
          corpusId: createdSchema.corpusId,
          headType: createdSchema.headType,
          relation: createdSchema.relation,
          tailType: createdSchema.tailType,
          canonicalKey: createdSchema.canonicalKey,
          frequency: createdSchema.frequency,
          state: createdSchema.state,
          stabilizationThreshold: createdSchema.stabilizationThreshold,
          firstSourceDocumentId: createdSchema.sourceDocumentIds[0] ?? contributionDocumentId,
          contributionPresent: false,
          isNew: true,
        });
        continue;
      }

      if (projection.corpusId !== group.schema.corpusId
        || projection.headType !== group.schema.headType
        || projection.relation !== group.schema.relation
        || projection.tailType !== group.schema.tailType
        || projection.canonicalKey !== group.schema.canonicalKey) {
        throw new Error('stored schema projection identifies inconsistent schema meaning');
      }

      const frequencyDelta = projection.contributionPresent ? 0 : group.frequency;
      const nextFrequency = projection.frequency + frequencyDelta;
      const intent: SchemaCanonicalizationMergeExisting = {
        mode: 'merge',
        schemaId: projection.schemaId,
        expectedMergeToken: projection.mergeToken,
        contributionDocumentId,
        frequencyDelta,
        desiredState: desiredSchemaState(projection.state, nextFrequency, threshold),
        stabilizationThreshold: threshold,
        updatedAt: nowIso(),
        aliasAdditions: group.aliases,
        factIdAdditions: [],
      };
      validateProjectionMerge(projection, intent);
      if (projection.state !== 'stable' && intent.desiredState === 'stable') {
        newlyStableSchemaIds.push(projection.schemaId);
      }
      mergeIntents.push(intent);
      schemaViews.push({
        schemaId: projection.schemaId,
        corpusId: projection.corpusId,
        headType: projection.headType,
        relation: projection.relation,
        tailType: projection.tailType,
        canonicalKey: projection.canonicalKey,
        frequency: nextFrequency,
        state: intent.desiredState,
        stabilizationThreshold: intent.stabilizationThreshold,
        firstSourceDocumentId: projection.firstSourceDocumentId ?? contributionDocumentId,
        contributionPresent: projection.contributionPresent,
        isNew: false,
        mergeToken: projection.mergeToken,
      });
    }

    return { schemaViews, mergeIntents, newlyStableSchemaIds };
  }
}

export function mergeSchemas(snapshot: MemorySnapshot, schemas: readonly Schema[]): MemorySnapshot {
  return {
    ...snapshot,
    schemas: [...snapshot.schemas, ...schemas],
  };
}
