import { describe, expect, it } from 'vitest';
import type {
  IMemoryFilter,
  INodeInitializer,
} from '../../../../src/domain/retrieval/memoryFilter.js';
import { createNotImplementedStub } from '../../../setup/testDoubles.js';

describe('TASK-MG-015: memory filter retrieval contracts', () => {
  it('allows IMemoryFilter to be typed via createNotImplementedStub', () => {
    const memoryFilter = createNotImplementedStub<IMemoryFilter>('IMemoryFilter');

    expect(() =>
      memoryFilter.filter({
        corpusId: 'corpus-1',
        text: 'What encodes p53?',
        topK: 10,
        topM: 5,
        threshold: 0.5,
        contextTokenLimit: 4096,
      }),
    ).toThrow('IMemoryFilter.filter() should not be called in this test');
  });

  it('allows INodeInitializer to be typed via createNotImplementedStub', () => {
    const initializer = createNotImplementedStub<INodeInitializer>('INodeInitializer');

    expect(() =>
      initializer.initialize({
        query: {
          corpusId: 'corpus-1',
          text: 'What encodes p53?',
          topK: 10,
          topM: 5,
          threshold: 0.5,
          contextTokenLimit: 4096,
        },
        candidates: {
          ontology: [],
          facts: [],
          passages: [],
          expandedTerms: [],
          fallbackRequired: false,
        },
      }),
    ).toThrow('INodeInitializer.initialize() should not be called in this test');
  });
});
