import { describe, expect, it } from 'vitest';
import type { CompositeExtractionRecord } from '../../../../src/domain/agent/index.js';
import type { FactCandidate } from '../../../../src/domain/memory/fact.js';
import type { Passage } from '../../../../src/domain/memory/passage.js';
import type { Schema } from '../../../../src/domain/memory/schema.js';
import {
  buildDocumentFacts,
  buildDocumentMemoryDelta,
} from '../../../../src/application/indexing/DocumentMemoryPlan.js';

const CORPUS_ID = 'c1';
const DOCUMENT_ID = 'doc-1';
const TS = '2026-01-01T00:00:00.000Z';

function passage(passageId: string): Passage {
  return {
    passageId,
    corpusId: CORPUS_ID,
    text: 'Alice authors Paper',
    normalizedText: 'alice authors paper',
    metadata: {
      documentId: DOCUMENT_ID,
      title: 'Document',
      sourceUrl: 'https://example.com/doc-1',
      language: 'en',
      sectionPath: [],
      chunkId: passageId,
      chunkIndex: Number(passageId.slice(1)),
      offsetStart: 0,
      offsetEnd: 19,
    },
    factIds: [],
    entityMentions: ['Alice', 'Paper'],
    qualityFlags: [],
    createdAt: TS,
    updatedAt: TS,
  };
}

function record(
  sourcePassage: Passage,
  candidate: FactCandidate,
): CompositeExtractionRecord {
  return {
    chunk: {
      corpusId: CORPUS_ID,
      documentId: DOCUMENT_ID,
      chunkId: sourcePassage.metadata.chunkId,
      text: sourcePassage.text,
      normalizedText: sourcePassage.normalizedText,
      language: 'en',
      metadata: sourcePassage.metadata,
    },
    candidateSchemas: [],
    candidateFacts: [candidate],
    sourcePassage,
    rawEntities: ['Alice', 'Paper'],
  };
}

function schema(): Schema {
  return {
    schemaId: 'schema:person::authors::paper',
    corpusId: CORPUS_ID,
    headType: 'Person',
    relation: 'authors',
    tailType: 'Paper',
    canonicalKey: 'person::authors::paper',
    aliases: [],
    frequency: 2,
    state: 'stable',
    stabilizationThreshold: 2,
    factIds: ['old-fact'],
    sourceDocumentIds: ['old-doc', DOCUMENT_ID],
    version: 1,
    createdAt: TS,
    updatedAt: TS,
  };
}

const candidate = (
  confidence: number,
  headEntity = 'Alice',
  overrides: Partial<FactCandidate> = {},
): FactCandidate => ({
  headEntity,
  headType: 'Person',
  relation: 'authors',
  tailEntity: 'Paper',
  tailType: 'Paper',
  supportingSpanIds: [],
  confidence,
  ...overrides,
});

describe('document memory mutation plan', () => {
  it('folds repeated fact identity while preserving pressure and every source link', () => {
    const passages = [passage('p0'), passage('p1')];
    const schemas = [schema()];
    const facts = buildDocumentFacts(
      CORPUS_ID,
      DOCUMENT_ID,
      [
        record(passages[0]!, candidate(0.7)),
        record(passages[1]!, candidate(0.9, 'Alice', {
          headType: 'person',
          tailType: 'paper',
        })),
      ],
      schemas,
      TS,
    );

    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      passageIds: ['p0', 'p1'],
      sourceDocumentIds: [DOCUMENT_ID],
      confidence: 0.9,
      headType: 'person',
      relation: 'authors',
      tailType: 'paper',
    });

    const delta = buildDocumentMemoryDelta(CORPUS_ID, schemas, facts, passages, TS);
    const factId = facts[0]!.factId;
    expect(delta.schemas[0]).toMatchObject({
      frequency: 2,
      factIds: ['old-fact', factId],
    });
    expect(delta.passages.map((item) => item.factIds)).toEqual([[factId], [factId]]);
  });

  it('uses the canonical schema relation for ID and folds relation case variation', () => {
    const passages = [passage('p0'), passage('p1')];
    const facts = buildDocumentFacts(
      CORPUS_ID,
      DOCUMENT_ID,
      [
        record(passages[0]!, candidate(0.7)),
        record(passages[1]!, candidate(0.8, 'Alice', { relation: 'Authors' })),
      ],
      [schema()],
      TS,
    );

    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ relation: 'authors', passageIds: ['p0', 'p1'] });
    expect(facts[0]?.factId).toContain(':authors:');
  });

  it('keeps facts with the same entities and relation distinct across canonical schemas', () => {
    const sourcePassage = passage('p0');
    const organizationSchema: Schema = {
      ...schema(),
      schemaId: 'schema:organization::authors::report',
      headType: 'Organization',
      tailType: 'Report',
      canonicalKey: 'organization::authors::report',
    };
    const records = [
      record(sourcePassage, candidate(0.9)),
      record(sourcePassage, candidate(0.8, 'Alice', {
        headType: 'Organization',
        tailType: 'Report',
      })),
    ];

    const facts = buildDocumentFacts(
      CORPUS_ID,
      DOCUMENT_ID,
      records,
      [schema(), organizationSchema],
      TS,
    );
    const repeated = buildDocumentFacts(
      CORPUS_ID,
      DOCUMENT_ID,
      records,
      [schema(), organizationSchema],
      TS,
    );

    expect(facts).toHaveLength(2);
    expect(new Set(facts.map((fact) => fact.factId)).size).toBe(2);
    expect(facts.map((fact) => [fact.schemaId, fact.factId])).toEqual([
      [schema().schemaId, expect.stringContaining(`:${schema().schemaId}:`)],
      [organizationSchema.schemaId, expect.stringContaining(`:${organizationSchema.schemaId}:`)],
    ]);
    expect(repeated.map((fact) => fact.factId)).toEqual(facts.map((fact) => fact.factId));

    const delta = buildDocumentMemoryDelta(
      CORPUS_ID,
      [schema(), organizationSchema],
      facts,
      [sourcePassage],
      TS,
    );
    for (const fact of facts) {
      const associatedSchema = delta.schemas.find((item) => item.schemaId === fact.schemaId);
      expect(associatedSchema?.factIds).toContain(fact.factId);
      expect(delta.schemas
        .filter((item) => item.schemaId !== fact.schemaId)
        .flatMap((item) => item.factIds)).not.toContain(fact.factId);
    }
  });

  it('fails closed when a sanitized ID collision carries different meaning', () => {
    const sourcePassage = passage('p0');
    expect(() => buildDocumentFacts(
      CORPUS_ID,
      DOCUMENT_ID,
      [
        record(sourcePassage, candidate(0.7, 'Alice A')),
        record(sourcePassage, candidate(0.8, 'Alice_A')),
      ],
      [schema()],
      TS,
    )).toThrow('identifies inconsistent headEntity');
  });

  it('fails closed when one canonical meaning maps to different schema IDs', () => {
    const sourcePassage = passage('p0');
    expect(() => buildDocumentFacts(
      CORPUS_ID,
      DOCUMENT_ID,
      [record(sourcePassage, candidate(0.9))],
      [schema(), { ...schema(), schemaId: 'schema:ambiguous' }],
      TS,
    )).toThrow('maps to multiple schema IDs');
  });

  it('rejects broken schema, passage, and corpus links before mutation', () => {
    const sourcePassage = passage('p0');
    const facts = buildDocumentFacts(
      CORPUS_ID,
      DOCUMENT_ID,
      [record(sourcePassage, candidate(0.9))],
      [schema()],
      TS,
    );
    expect(() => buildDocumentMemoryDelta(CORPUS_ID, [], facts, [sourcePassage], TS))
      .toThrow('references an absent schema');
    expect(() => buildDocumentMemoryDelta(CORPUS_ID, [schema()], facts, [], TS))
      .toThrow('references an absent passage');
    expect(() => buildDocumentMemoryDelta(
      CORPUS_ID,
      [schema()],
      [{ ...facts[0]!, corpusId: 'other-corpus' }],
      [sourcePassage],
      TS,
    )).toThrow('belongs to the wrong corpus');
  });
});
