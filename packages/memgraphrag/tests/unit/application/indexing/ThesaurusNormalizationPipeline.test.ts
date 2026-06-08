import { describe, it, expect, vi } from 'vitest';
import type { CompositeExtractionRecord } from '../../../../src/domain/agent/index.js';
import type { IThesaurus } from '../../../../src/domain/dictionary/index.js';
import { createNotImplementedStub } from '../../../setup/testDoubles.js';
import { normalizeExtractedEntities } from '../../../../src/application/indexing/ThesaurusNormalizationPipeline.js';

function createRecord(): CompositeExtractionRecord {
  return {
    chunk: {
      corpusId: 'corpus-1',
      documentId: 'doc-1',
      chunkId: 'doc-1:0',
      text: 'carcinoma affects tissue',
      normalizedText: 'carcinoma affects tissue',
      language: 'en',
      metadata: { documentId: 'doc-1', title: 'Doc', sourceUrl: 'https://example.com', language: 'en', sectionPath: ['Intro'], chunkId: 'doc-1:0', chunkIndex: 0, offsetStart: 0, offsetEnd: 10 },
    },
    candidateSchemas: [],
    candidateFacts: [{ headEntity: 'carcinoma', headType: 'Disease', relation: 'affects', tailEntity: 'tissue', tailType: 'Tissue', supportingSpanIds: [], confidence: 0.8 }],
    sourcePassage: {
      passageId: 'p-1', corpusId: 'corpus-1', text: 'carcinoma affects tissue', normalizedText: 'carcinoma affects tissue', metadata: { documentId: 'doc-1', title: 'Doc', sourceUrl: 'https://example.com', language: 'en', sectionPath: ['Intro'], chunkId: 'doc-1:0', chunkIndex: 0, offsetStart: 0, offsetEnd: 10 }, factIds: [], entityMentions: ['carcinoma'], qualityFlags: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    },
    rawEntities: ['carcinoma'],
  };
}

describe('TASK-MG-043: ThesaurusNormalizationPipeline', () => {
  it('normalizes raw entities through the thesaurus', async () => {
    const thesaurus = {
      ...createNotImplementedStub<IThesaurus>('IThesaurus'),
      normalize: vi.fn<IThesaurus['normalize']>().mockResolvedValue({ canonicalTerm: 'cancer', originalTerm: 'carcinoma', appliedRelations: [] }),
    } satisfies IThesaurus;

    const [normalized] = await normalizeExtractedEntities([createRecord()], thesaurus, 'en');
    expect(normalized?.rawEntities).toEqual(['cancer']);
  });

  it('rewrites fact candidate entity values to canonical terms', async () => {
    const thesaurus = {
      ...createNotImplementedStub<IThesaurus>('IThesaurus'),
      normalize: vi.fn<IThesaurus['normalize']>().mockResolvedValue({ canonicalTerm: 'cancer', originalTerm: 'carcinoma', appliedRelations: [] }),
    } satisfies IThesaurus;

    const [normalized] = await normalizeExtractedEntities([createRecord()], thesaurus, 'en');
    expect(normalized?.candidateFacts[0]?.headEntity).toBe('cancer');
  });

  it('updates passage entity mentions without duplication', async () => {
    const thesaurus = {
      ...createNotImplementedStub<IThesaurus>('IThesaurus'),
      normalize: vi.fn<IThesaurus['normalize']>().mockResolvedValue({ canonicalTerm: 'cancer', originalTerm: 'carcinoma', appliedRelations: [] }),
    } satisfies IThesaurus;

    const [normalized] = await normalizeExtractedEntities([{ ...createRecord(), sourcePassage: { ...createRecord().sourcePassage, entityMentions: ['carcinoma', 'cancer'] } }], thesaurus, 'en');
    expect(normalized?.sourcePassage.entityMentions).toEqual(['cancer']);
  });
});
