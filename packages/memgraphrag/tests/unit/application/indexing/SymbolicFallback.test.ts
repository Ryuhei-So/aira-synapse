import { describe, expect, it } from 'vitest';
import type { Fact } from '../../../../src/domain/memory/fact.js';
import { SymbolicCanonicalizer } from '../../../../src/application/indexing/SymbolicCanonicalizer.js';
import { SymbolicConflictDetector } from '../../../../src/application/indexing/SymbolicConflictDetector.js';

const now = '2026-01-01T00:00:00.000Z';

function createFact(overrides: Partial<Fact> = {}): Fact {
  return {
    factId: 'fact-1',
    corpusId: 'corpus-1',
    schemaId: 'schema-1',
    headEntity: 'Alice',
    headType: 'Researcher',
    relation: 'authors',
    tailEntity: 'Paper A',
    tailType: 'Paper',
    state: 'active',
    passageIds: ['passage-1'],
    sourceDocumentIds: ['doc-1'],
    confidence: 0.9,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('TASK-MG-048: symbolic fallbacks', () => {
  it('canonicalizes exact aliases without embeddings', async () => {
    const canonicalizer = new SymbolicCanonicalizer({
      exactAliases: {
        researcher: 'person',
        writes: 'authors',
      },
    });

    const result = await canonicalizer.canonicalize({
      headType: 'Researcher',
      relation: 'Writes',
      tailType: 'Paper',
      canonicalKey: 'researcher::writes::paper',
      aliases: [],
      confidence: 0.8,
    });

    expect(result.canonicalHeadType).toBe('person');
    expect(result.canonicalRelation).toBe('authors');
    expect(result.canonicalTailType).toBe('paper');
  });

  it('detects mutually exclusive conflicts by exact symbolic match', async () => {
    const detector = new SymbolicConflictDetector({
      loadFacts: async () => [
        createFact({ factId: 'fact-2', tailEntity: 'Paper B' }),
        createFact({ factId: 'fact-3', relation: 'cites', tailEntity: 'Paper C' }),
      ],
    });

    const result = await detector.detect({
      corpusId: 'corpus-1',
      newFact: createFact(),
      activeFactLimit: 10,
      similarityThreshold: 0.8,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.conflictType).toBe('mutually_exclusive');
    expect(result[0]?.conflictingFacts).toEqual([expect.objectContaining({ factId: 'fact-2' })]);
  });

  it('detects temporal conflicts when the exact triple changes scope', async () => {
    const detector = new SymbolicConflictDetector({
      loadFacts: async () => [
        createFact({ factId: 'fact-2', temporalScope: '2024' }),
      ],
    });

    const result = await detector.detect({
      corpusId: 'corpus-1',
      newFact: createFact({ temporalScope: '2025' }),
      activeFactLimit: 10,
      similarityThreshold: 0.8,
    });

    expect(result[0]?.conflictType).toBe('temporal');
    expect(result[0]?.candidates[0]).toEqual(expect.objectContaining({ symbolicMatch: true, similarity: 1 }));
  });
});
