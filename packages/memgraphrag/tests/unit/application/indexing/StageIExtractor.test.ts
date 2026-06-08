import { describe, it, expect, vi } from 'vitest';
import type { CompositeExtractionRecord, ExtractionChunk, IExtractionAgent } from '../../../../src/domain/agent/index.js';
import type { INLPExtractor } from '../../../../src/domain/provider/index.js';
import type { IndexDocumentInput } from '../../../../src/application/indexing/StageIExtractor.js';
import { StageIExtractor } from '../../../../src/application/indexing/StageIExtractor.js';
import { createNotImplementedStub } from '../../../setup/testDoubles.js';

function createInput(markdown: string): IndexDocumentInput {
  return {
    documentId: 'doc-1',
    markdown,
    title: 'Document Title',
    sourceUrl: 'https://example.com/doc',
    sourceType: 'md',
    language: 'en',
  };
}

function createRecord(chunk: ExtractionChunk): CompositeExtractionRecord {
  return {
    chunk,
    candidateSchemas: [],
    candidateFacts: [],
    sourcePassage: {
      passageId: `passage:${chunk.chunkId}`,
      corpusId: chunk.corpusId,
      text: chunk.text,
      normalizedText: chunk.normalizedText,
      metadata: chunk.metadata,
      factIds: [],
      entityMentions: [],
      qualityFlags: [],
      qualityScore: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    rawEntities: [],
  };
}

describe('TASK-MG-030: StageIExtractor', () => {
  it('preprocesses markdown by normalizing unicode, whitespace, and control characters', () => {
    const extractor = new StageIExtractor(
      createNotImplementedStub<INLPExtractor>('INLPExtractor'),
      createNotImplementedStub<IExtractionAgent>('IExtractionAgent'),
    );

    const processed = extractor.preprocessMarkdown('A\u00A0B\r\nC\u0007  D');
    expect(processed).toBe('A B\nC D');
  });

  it('flags low-quality markdown patterns', () => {
    const extractor = new StageIExtractor(
      createNotImplementedStub<INLPExtractor>('INLPExtractor'),
      createNotImplementedStub<IExtractionAgent>('IExtractionAgent'),
    );

    const quality = extractor.validateMarkdownQuality('```ts\nconst x = 1;\n```\n|a|b|\n|---|---|');
    expect(quality.flags).toContain('code-heavy');
    expect(quality.flags).toContain('table-heavy');
    expect(quality.score).toBeLessThan(1);
  });

  it('chunks markdown by headings and preserves section paths', () => {
    const extractor = new StageIExtractor(
      createNotImplementedStub<INLPExtractor>('INLPExtractor'),
      createNotImplementedStub<IExtractionAgent>('IExtractionAgent'),
    );

    const chunks = extractor.chunkDocument('corpus-1', createInput('# Intro\nAlpha\n## Methods\nBeta\n## References\n[1] Ref'));

    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.metadata.sectionPath).toEqual(['Intro']);
    expect(chunks[1]?.metadata.sectionPath).toEqual(['Intro', 'Methods']);
    expect(chunks[2]?.metadata.sectionPath).toEqual(['Intro', 'References']);
  });

  it('marks chunk features for code, tables, and references', () => {
    const extractor = new StageIExtractor(
      createNotImplementedStub<INLPExtractor>('INLPExtractor'),
      createNotImplementedStub<IExtractionAgent>('IExtractionAgent'),
    );

    const chunks = extractor.chunkMarkdown('corpus-1', createInput('# Data\n```py\nprint(1)\n```\n|a|b|\n[1] ref'));

    expect(chunks[0]?.features.hasCodeBlock).toBe(true);
    expect(chunks[0]?.features.hasTable).toBe(true);
    expect(chunks[0]?.features.hasReferences).toBe(true);
  });

  it('extracts chunk records and merges NLP entities with agent output', async () => {
    const nlp = {
      ...createNotImplementedStub<INLPExtractor>('INLPExtractor'),
      extract: vi.fn<INLPExtractor['extract']>().mockResolvedValue({
        language: 'en',
        entities: [{ text: 'Graph Neural Network', label: 'METHOD', start: 0, end: 20 }],
        nounPhrases: ['citation graph'],
      }),
    } satisfies INLPExtractor;

    const agent = {
      ...createNotImplementedStub<IExtractionAgent>('IExtractionAgent'),
      extract: vi.fn<IExtractionAgent['extract']>().mockImplementation(async (chunk) => createRecord(chunk)),
    } satisfies IExtractionAgent;

    const extractor = new StageIExtractor(nlp, agent);
    const [record] = await extractor.extractChunks('corpus-1', createInput('# Intro\nGraph Neural Network improves citation graph retrieval.'));

    expect(record?.rawEntities).toEqual(['Graph Neural Network', 'citation graph']);
    expect(record?.sourcePassage.entityMentions).toEqual(['Graph Neural Network', 'citation graph']);
    expect(record?.sourcePassage.qualityFlags).toContain('well-formed');
  });

  it('generates deterministic chunk ids and offsets', () => {
    const extractor = new StageIExtractor(
      createNotImplementedStub<INLPExtractor>('INLPExtractor'),
      createNotImplementedStub<IExtractionAgent>('IExtractionAgent'),
    );

    const [chunk] = extractor.chunkDocument('corpus-1', createInput('# Intro\nParagraph text'));
    expect(chunk?.chunkId).toBe('doc-1:0');
    expect(chunk?.metadata.offsetStart).toBe(0);
    expect(chunk?.metadata.offsetEnd).toBeGreaterThan(chunk?.metadata.offsetStart ?? 0);
  });
});
