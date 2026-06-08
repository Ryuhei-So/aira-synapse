import { describe, expect, it } from 'vitest';
import type {
  ExtractionChunk,
  IExtractionAgent,
  ISchemaCanonicalizer,
} from '../../../../src/domain/agent/extraction.js';
import { createNotImplementedStub } from '../../../setup/testDoubles.js';

describe('TASK-MG-010: extraction agent contracts', () => {
  it('allows IExtractionAgent to be typed via createNotImplementedStub', () => {
    const agent = createNotImplementedStub<IExtractionAgent>('IExtractionAgent');

    expect(() => agent.extract(makeChunk())).toThrow(
      'IExtractionAgent.extract() should not be called in this test',
    );
  });

  it('allows ISchemaCanonicalizer to be typed via createNotImplementedStub', () => {
    const canonicalizer = createNotImplementedStub<ISchemaCanonicalizer>(
      'ISchemaCanonicalizer',
    );

    expect(() =>
      canonicalizer.canonicalize({
        headType: 'gene',
        relation: 'encodes',
        tailType: 'protein',
        canonicalKey: 'gene::encodes::protein',
        aliases: [],
        confidence: 0.9,
      }),
    ).toThrow(
      'ISchemaCanonicalizer.canonicalize() should not be called in this test',
    );
  });

  it('requires corpusId, text, language, and metadata on ExtractionChunk', () => {
    const chunk: ExtractionChunk = makeChunk();

    expect(chunk).toMatchObject({
      corpusId: 'corpus-1',
      text: 'TP53 encodes p53.',
      language: 'en',
      metadata: {
        documentId: 'doc-1',
        chunkId: 'chunk-1',
      },
    });
  });
});

function makeChunk(): ExtractionChunk {
  return {
    corpusId: 'corpus-1',
    documentId: 'doc-1',
    chunkId: 'chunk-1',
    text: 'TP53 encodes p53.',
    normalizedText: 'tp53 encodes p53.',
    language: 'en',
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
  };
}
