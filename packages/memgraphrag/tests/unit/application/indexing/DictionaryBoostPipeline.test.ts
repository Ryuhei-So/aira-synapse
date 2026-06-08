import { describe, it, expect, vi } from 'vitest';
import type { ITermDictionary, DictionaryMatch, TermDictionaryEntry } from '../../../../src/domain/dictionary/index.js';
import type { CompositeExtractionRecord } from '../../../../src/domain/agent/index.js';
import { createNotImplementedStub } from '../../../setup/testDoubles.js';
import { boostEntities, recoverMissedCompositeTerms } from '../../../../src/application/indexing/DictionaryBoostPipeline.js';

const entry: TermDictionaryEntry = {
  termId: 'term-1',
  term: 'graph neural network',
  canonicalForm: 'graph neural network',
  domainCategory: 'ml',
  aliases: ['GNN'],
  frequency: 4,
  confidence: 0.9,
  source: 'manual',
  version: '1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function createRecord(): CompositeExtractionRecord {
  return {
    chunk: {
      corpusId: 'corpus-1',
      documentId: 'doc-1',
      chunkId: 'doc-1:0',
      text: 'A graph neural network is used.',
      normalizedText: 'a graph neural network is used.',
      language: 'en',
      metadata: { documentId: 'doc-1', title: 'Doc', sourceUrl: 'https://example.com', language: 'en', sectionPath: ['Intro'], chunkId: 'doc-1:0', chunkIndex: 0, offsetStart: 0, offsetEnd: 10 },
    },
    candidateSchemas: [],
    candidateFacts: [],
    sourcePassage: {
      passageId: 'p-1', corpusId: 'corpus-1', text: 'A graph neural network is used.', normalizedText: 'a graph neural network is used.', metadata: { documentId: 'doc-1', title: 'Doc', sourceUrl: 'https://example.com', language: 'en', sectionPath: ['Intro'], chunkId: 'doc-1:0', chunkIndex: 0, offsetStart: 0, offsetEnd: 10 }, factIds: [], entityMentions: ['network'], qualityFlags: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    },
    rawEntities: ['network'],
  };
}

describe('TASK-MG-043: DictionaryBoostPipeline', () => {
  it('recovers multi-word dictionary terms from raw text', async () => {
    const dictionary = {
      ...createNotImplementedStub<ITermDictionary>('ITermDictionary'),
      match: vi.fn<ITermDictionary['match']>().mockResolvedValue([{ entry, matchedText: 'graph neural network', boostFactor: 2 } satisfies DictionaryMatch]),
    } satisfies ITermDictionary;

    const terms = await recoverMissedCompositeTerms('A graph neural network model', dictionary, 'en');
    expect(terms).toEqual(['graph neural network']);
  });

  it('boosts extracted records with matched dictionary entities', async () => {
    const dictionary = {
      ...createNotImplementedStub<ITermDictionary>('ITermDictionary'),
      match: vi.fn<ITermDictionary['match']>().mockResolvedValue([{ entry, matchedText: 'graph neural network', boostFactor: 2 }]),
    } satisfies ITermDictionary;

    const [boosted] = await boostEntities([createRecord()], dictionary, 'en');
    expect(boosted?.rawEntities).toEqual(['network', 'graph neural network']);
    expect(boosted?.sourcePassage.entityMentions).toEqual(['network', 'graph neural network']);
  });

  it('does not duplicate canonical terms already present', async () => {
    const dictionary = {
      ...createNotImplementedStub<ITermDictionary>('ITermDictionary'),
      match: vi.fn<ITermDictionary['match']>().mockResolvedValue([{ entry, matchedText: 'graph neural network', boostFactor: 2 }]),
    } satisfies ITermDictionary;

    const [boosted] = await boostEntities([{ ...createRecord(), rawEntities: ['graph neural network'] }], dictionary, 'en');
    expect(boosted?.rawEntities).toEqual(['graph neural network']);
  });
});
