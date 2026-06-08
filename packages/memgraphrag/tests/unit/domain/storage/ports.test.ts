import { describe, expect, it } from 'vitest';
import type {
  IGraphStore,
  IMemoryStore,
  IVectorIndex,
  MemorySnapshot,
} from '../../../../src/domain/storage/graphStore.js';
import { createNotImplementedStub } from '../../../setup/testDoubles.js';

describe('TASK-MG-017: storage port contracts', () => {
  it('allows IGraphStore to be typed via createNotImplementedStub', () => {
    const graphStore = createNotImplementedStub<IGraphStore>('IGraphStore');

    expect(() => graphStore.getNode('corpus-1', 'node-1')).toThrow(
      'IGraphStore.getNode() should not be called in this test',
    );
  });

  it('allows IVectorIndex to be typed via createNotImplementedStub', () => {
    const vectorIndex = createNotImplementedStub<IVectorIndex>('IVectorIndex');

    expect(() =>
      vectorIndex.search({
        corpusId: 'corpus-1',
        namespace: 'passage',
        queryVector: [0.1, 0.2],
        topK: 5,
        threshold: 0.5,
      }),
    ).toThrow('IVectorIndex.search() should not be called in this test');
  });

  it('allows IMemoryStore to be typed via createNotImplementedStub', () => {
    const memoryStore = createNotImplementedStub<IMemoryStore>('IMemoryStore');
    const snapshot: MemorySnapshot = {
      corpusId: 'corpus-1',
      exportedAt: '2024-01-01T00:00:00Z',
      schemas: [],
      facts: [],
      passages: [],
      schemaVersion: 1,
    };

    expect(() => memoryStore.save(snapshot)).toThrow(
      'IMemoryStore.save() should not be called in this test',
    );
  });
});
