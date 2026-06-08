import { describe, expect, it } from 'vitest';
import type {
  ConflictType,
  IConflictDetector,
} from '../../../../src/domain/agent/conflictDetection.js';
import { createNotImplementedStub } from '../../../setup/testDoubles.js';

describe('TASK-MG-011: conflict detection contracts', () => {
  it('allows IConflictDetector to be typed via createNotImplementedStub', () => {
    const detector = createNotImplementedStub<IConflictDetector>('IConflictDetector');

    expect(() =>
      detector.detect({
        corpusId: 'corpus-1',
        newFact: makeFact(),
        activeFactLimit: 10,
        similarityThreshold: 0.8,
      }),
    ).toThrow('IConflictDetector.detect() should not be called in this test');
  });

  it('supports every ConflictType union member', () => {
    const conflictTypes: ConflictType[] = [
      'mutually_exclusive',
      'temporal',
      'granularity',
    ];

    expect(conflictTypes).toEqual([
      'mutually_exclusive',
      'temporal',
      'granularity',
    ]);
  });
});

function makeFact() {
  return {
    corpusId: 'corpus-1',
    factId: 'fact-1',
    schemaId: 'schema-1',
    headEntity: 'TP53',
    headType: 'gene',
    relation: 'encodes',
    tailEntity: 'p53',
    tailType: 'protein',
    state: 'active' as const,
    passageIds: ['passage-1'],
    sourceDocumentIds: ['doc-1'],
    confidence: 0.9,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  };
}
