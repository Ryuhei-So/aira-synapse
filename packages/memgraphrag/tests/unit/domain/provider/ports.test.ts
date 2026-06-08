import { describe, expect, it } from 'vitest';
import type {
  IEmbeddingProvider,
  ILLMProvider,
  INLPExtractor,
} from '../../../../src/domain/provider/llmProvider.js';
import { createNotImplementedStub } from '../../../setup/testDoubles.js';

describe('TASK-MG-017: provider port contracts', () => {
  it('allows ILLMProvider to be typed via createNotImplementedStub', () => {
    const llm = createNotImplementedStub<ILLMProvider>('ILLMProvider');

    expect(() =>
      llm.generate({
        prompt: 'Summarize the findings.',
        responseFormat: 'text',
      }),
    ).toThrow('ILLMProvider.generate() should not be called in this test');
  });

  it('allows IEmbeddingProvider to be typed via createNotImplementedStub', () => {
    const embedding = createNotImplementedStub<IEmbeddingProvider>(
      'IEmbeddingProvider',
    );

    expect(() => embedding.embed({ texts: ['TP53 encodes p53.'] })).toThrow(
      'IEmbeddingProvider.embed() should not be called in this test',
    );
  });

  it('allows INLPExtractor to be typed via createNotImplementedStub', () => {
    const extractor = createNotImplementedStub<INLPExtractor>('INLPExtractor');

    expect(() => extractor.extract({ text: 'TP53 encodes p53.', language: 'en' })).toThrow(
      'INLPExtractor.extract() should not be called in this test',
    );
  });
});
