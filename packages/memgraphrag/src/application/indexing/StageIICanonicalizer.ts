import type { CompositeExtractionRecord, ISchemaCanonicalizer } from '../../domain/agent/index.js';
import { computeCanonicalKey, type Schema } from '../../domain/memory/schema.js';
import type { MemorySnapshot } from '../../domain/memory/globalMemory.js';
import type { IIndexingMemory } from '../../domain/storage/index.js';

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
}

export function mergeSchemas(snapshot: MemorySnapshot, schemas: readonly Schema[]): MemorySnapshot {
  return {
    ...snapshot,
    schemas: [...snapshot.schemas, ...schemas],
  };
}
