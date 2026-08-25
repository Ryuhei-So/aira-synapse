import type { CompositeExtractionRecord } from '../../domain/agent/index.js';
import type { Fact } from '../../domain/memory/fact.js';
import type { Passage } from '../../domain/memory/passage.js';
import {
  computeCanonicalKey,
  normalizeSchemaTerm,
  type Schema,
} from '../../domain/memory/schema.js';
import type { IndexingMemoryDelta } from '../../domain/storage/indexingMemory.js';

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

const FACT_MEANING_FIELDS = [
  'corpusId',
  'schemaId',
  'headEntity',
  'headType',
  'relation',
  'tailEntity',
  'tailType',
  'state',
] as const satisfies readonly (keyof Fact)[];

function foldFact(existing: Fact, incoming: Fact): Fact {
  for (const field of FACT_MEANING_FIELDS) {
    if (existing[field] !== incoming[field]) {
      throw new Error(`factId ${incoming.factId} identifies inconsistent ${field}`);
    }
  }
  return {
    ...existing,
    passageIds: uniqueStrings([...existing.passageIds, ...incoming.passageIds]),
    sourceDocumentIds: uniqueStrings([
      ...existing.sourceDocumentIds,
      ...incoming.sourceDocumentIds,
    ]),
    confidence: Math.max(existing.confidence, incoming.confidence),
  };
}

/**
 * Build one fact identity per document-level fact ID.
 *
 * Schema frequency remains candidate-pressure authority in Stage II. This fold
 * owns fact identity only: repeated supporting chunks extend provenance without
 * multiplying the persisted fact.
 */
export function buildDocumentFacts(
  corpusId: string,
  documentId: string,
  records: readonly CompositeExtractionRecord[],
  schemas: readonly Schema[],
  timestamp: string,
): readonly Fact[] {
  const schemaByMeaning = new Map<string, Schema>();
  for (const schema of schemas) {
    const meaning = computeCanonicalKey(schema.headType, schema.relation, schema.tailType);
    const existing = schemaByMeaning.get(meaning);
    if (existing && existing.schemaId !== schema.schemaId) {
      throw new Error(`canonical schema key ${meaning} maps to multiple schema IDs`);
    }
    schemaByMeaning.set(meaning, schema);
  }
  const facts = new Map<string, Fact>();

  for (const record of records) {
    for (const candidate of record.candidateFacts) {
      if (!candidate.headType || !candidate.relation || !candidate.tailType) continue;
      const matchedSchema = schemaByMeaning.get(computeCanonicalKey(
        candidate.headType,
        candidate.relation,
        candidate.tailType,
      ));
      if (!matchedSchema) continue;

      const canonicalHeadType = normalizeSchemaTerm(matchedSchema.headType);
      const canonicalRelation = normalizeSchemaTerm(matchedSchema.relation);
      const canonicalTailType = normalizeSchemaTerm(matchedSchema.tailType);
      // Fact meaning includes its canonical schema: identical entity/relation text
      // can legitimately occur under different typed schemas in one document.
      const factId = `fact:${documentId}:${matchedSchema.schemaId}:${candidate.headEntity}:${canonicalRelation}:${candidate.tailEntity}`
        .replace(/\s+/g, '_');
      const incoming: Fact = {
        factId,
        corpusId,
        schemaId: matchedSchema.schemaId,
        headEntity: candidate.headEntity,
        headType: canonicalHeadType,
        relation: canonicalRelation,
        tailEntity: candidate.tailEntity,
        tailType: canonicalTailType,
        state: matchedSchema.state === 'stable' ? 'active' : 'inactive',
        passageIds: [record.sourcePassage.passageId],
        sourceDocumentIds: [documentId],
        confidence: candidate.confidence,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const existing = facts.get(factId);
      facts.set(factId, existing ? foldFact(existing, incoming) : incoming);
    }
  }

  return [...facts.values()];
}

/** One authority for the fact links written to every memory section. */
export function buildDocumentMemoryDelta(
  corpusId: string,
  schemas: readonly Schema[],
  facts: readonly Fact[],
  passages: readonly Passage[],
  exportedAt: string,
): IndexingMemoryDelta {
  const schemaIds = new Set(schemas.map((schema) => schema.schemaId));
  const passageIds = new Set(passages.map((passage) => passage.passageId));
  const factIdsBySchema = new Map<string, string[]>();
  const factIdsByPassage = new Map<string, string[]>();
  for (const fact of facts) {
    if (fact.corpusId !== corpusId) {
      throw new Error(`fact ${fact.factId} belongs to the wrong corpus`);
    }
    if (!schemaIds.has(fact.schemaId)) {
      throw new Error(`fact ${fact.factId} references an absent schema`);
    }
    const schemaFactIds = factIdsBySchema.get(fact.schemaId) ?? [];
    schemaFactIds.push(fact.factId);
    factIdsBySchema.set(fact.schemaId, schemaFactIds);
    for (const passageId of fact.passageIds) {
      if (!passageIds.has(passageId)) {
        throw new Error(`fact ${fact.factId} references an absent passage`);
      }
      const passageFactIds = factIdsByPassage.get(passageId) ?? [];
      passageFactIds.push(fact.factId);
      factIdsByPassage.set(passageId, passageFactIds);
    }
  }

  return {
    corpusId,
    schemas: schemas.map((schema) => ({
      ...schema,
      factIds: uniqueStrings([
        ...schema.factIds,
        ...(factIdsBySchema.get(schema.schemaId) ?? []),
      ]),
    })),
    facts,
    passages: passages.map((passage) => ({
      ...passage,
      factIds: uniqueStrings([
        ...passage.factIds,
        ...(factIdsByPassage.get(passage.passageId) ?? []),
      ]),
    })),
    exportedAt,
  };
}
