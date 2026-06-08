import type { CompositeExtractionRecord, ISchemaCanonicalizer } from '../../domain/agent/index.js';
import type { Fact } from '../../domain/memory/fact.js';
import { computeCanonicalKey, type Schema } from '../../domain/memory/schema.js';
import type { MemorySnapshot } from '../../domain/memory/globalMemory.js';
import type { IMemoryStore } from '../../domain/storage/index.js';

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
    private readonly store: IMemoryStore,
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

  public async incrementSchemaFrequency(schemas: readonly Schema[]): Promise<void> {
    const snapshot = await this.store.load(this.corpusId);
    const existing = new Map(snapshot.schemas.map((schema) => [schema.schemaId, schema]));

    for (const schema of schemas) {
      const current = existing.get(schema.schemaId);
      if (current) {
        existing.set(schema.schemaId, {
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
        existing.set(schema.schemaId, schema);
      }
    }

    await this.store.save({
      ...snapshot,
      schemas: [...existing.values()],
    });
  }

  public async promoteStableSchemas(threshold = 2): Promise<readonly string[]> {
    const snapshot = await this.store.load(this.corpusId);
    const stableSchemaIds: string[] = [];

    const schemas = snapshot.schemas.map((schema) => {
      if (schema.frequency >= threshold && schema.state !== 'stable') {
        stableSchemaIds.push(schema.schemaId);
        return {
          ...schema,
          state: 'stable' as const,
          stabilizationThreshold: threshold,
          updatedAt: nowIso(),
        };
      }
      return schema;
    });

    await this.store.save({ ...snapshot, schemas });
    return stableSchemaIds;
  }

  public async cascadeActivateFacts(stableSchemaIds: readonly string[]): Promise<number> {
    if (stableSchemaIds.length === 0) {
      return 0;
    }

    const stableSet = new Set(stableSchemaIds);
    const snapshot = await this.store.load(this.corpusId);
    let activated = 0;
    const facts: Fact[] = snapshot.facts.map((fact) => {
      if (fact.state === 'inactive' && stableSet.has(fact.schemaId)) {
        activated += 1;
        return {
          ...fact,
          state: 'active',
          updatedAt: nowIso(),
        };
      }
      return fact;
    });

    await this.store.save({ ...snapshot, facts });
    return activated;
  }
}

export function mergeSchemas(snapshot: MemorySnapshot, schemas: readonly Schema[]): MemorySnapshot {
  return {
    ...snapshot,
    schemas: [...snapshot.schemas, ...schemas],
  };
}
