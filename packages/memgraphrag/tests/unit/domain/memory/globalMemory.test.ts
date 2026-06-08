import { describe, expect, it } from 'vitest';
import type {
  GlobalMemory,
  MemorySnapshot,
  MemoryStatistics,
} from '../../../../src/domain/memory/globalMemory.js';
import { createNotImplementedStub } from '../../../setup/testDoubles.js';

describe('TASK-MG-009: global memory contracts', () => {
  it('allows GlobalMemory to be typed via createNotImplementedStub', () => {
    const memory = createNotImplementedStub<GlobalMemory>('GlobalMemory');

    expect(() => memory.getSchema('schema-1')).toThrow(
      'GlobalMemory.getSchema() should not be called in this test',
    );
  });

  it('allows MemorySnapshot to be typed with all required properties', () => {
    const snapshot: MemorySnapshot = {
      corpusId: 'corpus-1',
      exportedAt: '2024-01-01T00:00:00Z',
      schemas: [],
      facts: [],
      passages: [],
      schemaVersion: 1,
    };

    expect(snapshot).toMatchObject({
      corpusId: 'corpus-1',
      exportedAt: '2024-01-01T00:00:00Z',
      schemaVersion: 1,
    });
    expect(snapshot.schemas).toEqual([]);
    expect(snapshot.facts).toEqual([]);
    expect(snapshot.passages).toEqual([]);
  });

  it('allows MemoryStatistics to be typed with all required properties', () => {
    const statistics: MemoryStatistics = {
      corpusId: 'corpus-1',
      totalSchemas: 1,
      stableSchemas: 1,
      totalFacts: 2,
      activeFacts: 1,
      inactiveFacts: 1,
      totalPassages: 3,
      linkedFacts: 2,
      detectedConflicts: 1,
      resolvedConflicts: 1,
      connectedComponents: 1,
    };

    expect(statistics).toMatchObject({
      corpusId: 'corpus-1',
      totalSchemas: 1,
      stableSchemas: 1,
      totalFacts: 2,
      activeFacts: 1,
      inactiveFacts: 1,
      totalPassages: 3,
      linkedFacts: 2,
      detectedConflicts: 1,
      resolvedConflicts: 1,
      connectedComponents: 1,
    });
  });
});
