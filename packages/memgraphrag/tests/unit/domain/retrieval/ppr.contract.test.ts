import { describe, expect, it } from 'vitest';
import type {
  IContextBuilder,
  IGraphProjection,
  ILexicalRetriever,
  IPPR,
  PPRResult,
} from '../../../../src/domain/retrieval/ppr.js';
import type { Passage } from '../../../../src/domain/memory/passage.js';
import { createNotImplementedStub } from '../../../setup/testDoubles.js';

describe('TASK-MG-016: ppr and retrieval contracts', () => {
  it('allows IPPR to be typed via createNotImplementedStub', () => {
    const ppr = createNotImplementedStub<IPPR>('IPPR');
    const projection = createNotImplementedStub<IGraphProjection>('IGraphProjection');

    expect(() =>
      ppr.run(
        {
          corpusId: 'corpus-1',
          initialVector: { scores: { 'node-1': 1 }, fallbackTriggered: false },
          teleportProbability: 0.5,
          convergenceEpsilon: 1e-6,
          maxIterations: 50,
          hubDegreeThreshold: 50,
          topK: 10,
          topM: 5,
        },
        projection,
      ),
    ).toThrow('IPPR.run() should not be called in this test');
  });

  it('allows IGraphProjection to be typed via createNotImplementedStub', () => {
    const projection = createNotImplementedStub<IGraphProjection>('IGraphProjection');

    expect(() => projection.getTransitions('corpus-1')).toThrow(
      'IGraphProjection.getTransitions() should not be called in this test',
    );
  });

  it('allows ILexicalRetriever to be typed via createNotImplementedStub', () => {
    const retriever = createNotImplementedStub<ILexicalRetriever>('ILexicalRetriever');

    expect(() => retriever.indexPassages('corpus-1', [makePassage()])).toThrow(
      'ILexicalRetriever.indexPassages() should not be called in this test',
    );
  });

  it('allows IContextBuilder to be typed via createNotImplementedStub', () => {
    const builder = createNotImplementedStub<IContextBuilder>('IContextBuilder');

    expect(() =>
      builder.build(
        {
          corpusId: 'corpus-1',
          text: 'What encodes p53?',
          topK: 10,
          topM: 5,
          threshold: 0.5,
          contextTokenLimit: 4096,
        },
        makePprResult(),
      ),
    ).toThrow('IContextBuilder.build() should not be called in this test');
  });
});

function makePassage(): Passage {
  return {
    corpusId: 'corpus-1',
    passageId: 'passage-1',
    text: 'TP53 encodes p53.',
    normalizedText: 'tp53 encodes p53.',
    metadata: {
      documentId: 'doc-1',
      title: 'A paper',
      sourceUrl: 'https://example.com',
      language: 'en',
      sectionPath: ['Abstract'],
      chunkId: 'chunk-1',
      chunkIndex: 0,
      offsetStart: 0,
      offsetEnd: 18,
    },
    factIds: ['fact-1'],
    entityMentions: ['TP53', 'p53'],
    qualityFlags: [],
    qualityScore: 0.9,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  };
}

function makePprResult(): PPRResult {
  return {
    rankedPassages: [{ nodeId: 'passage-1', score: 0.9, layer: 'passage' }],
    rankedEntities: [{ nodeId: 'fact-1', score: 0.8, layer: 'fact' }],
    iterations: 10,
    converged: true,
    l1Delta: 0.000001,
  };
}
