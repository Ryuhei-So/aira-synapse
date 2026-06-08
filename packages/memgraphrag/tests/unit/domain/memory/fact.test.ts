import { describe, expect, it } from 'vitest';
import { hasPassageGrounding } from '../../../../src/domain/memory/fact.js';
import type { Fact } from '../../../../src/domain/memory/fact.js';

describe('TASK-MG-008: fact passage grounding', () => {
  it('returns true when passageIds contains at least one entry', () => {
    expect(hasPassageGrounding(makeFact(['passage-1']))).toBe(true);
  });

  it('returns false when passageIds is empty', () => {
    expect(hasPassageGrounding(makeFact([]))).toBe(false);
  });
});

function makeFact(passageIds: readonly string[]): Fact {
  return {
    corpusId: 'corpus-1',
    factId: 'fact-1',
    schemaId: 'schema-1',
    headEntity: 'TP53',
    headType: 'gene',
    relation: 'encodes',
    tailEntity: 'p53',
    tailType: 'protein',
    state: 'active',
    passageIds,
    sourceDocumentIds: ['doc-1'],
    confidence: 0.9,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  };
}
