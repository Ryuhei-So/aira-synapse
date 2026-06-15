/**
 * Tests for AliasAwareContextBuilder (T-012).
 */
import { describe, it, expect, vi } from 'vitest';
import { AliasAwareContextBuilder } from '../../../../src/application/query/AliasAwareContextBuilder.js';
import type { IContextBuilder, ContextBundle, PPRResult } from '../../../../src/domain/retrieval/ppr.js';
import type { QueryRequest } from '../../../../src/domain/retrieval/memoryFilter.js';
import type { ITermDictionary, DictionaryMatch, TermDictionaryEntry } from '../../../../src/domain/dictionary/termDictionary.js';
import type { IThesaurus, ThesaurusRelation } from '../../../../src/domain/dictionary/thesaurus.js';

function makeEntry(overrides: Partial<TermDictionaryEntry> = {}): TermDictionaryEntry {
  return {
    termId: 'lex:test:einstein',
    term: 'Einstein',
    canonicalForm: 'Albert Einstein',
    domainCategory: 'science',
    aliases: ['A. Einstein'],
    frequency: 5,
    confidence: 0.9,
    source: 'llm_extraction',
    version: '1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const baseBundle: ContextBundle = {
  promptContext: '## Relevant Passages\n\nSome passage text.\n\n',
  citedPassages: [],
  citedFacts: [],
  confidence: 0.5,
};

function mockInnerBuilder(): IContextBuilder {
  return { build: vi.fn().mockResolvedValue(baseBundle) };
}

function mockDictionary(matches: DictionaryMatch[]): ITermDictionary {
  return {
    match: vi.fn().mockResolvedValue(matches),
    upsertEntries: vi.fn(),
    suggest: vi.fn().mockResolvedValue([]),
    exportJson: vi.fn().mockResolvedValue({}),
    importJson: vi.fn(),
    getStatistics: vi.fn(),
  };
}

function mockThesaurus(relations: ThesaurusRelation[] = []): IThesaurus {
  return {
    normalize: vi.fn().mockResolvedValue({ canonicalTerm: '', originalTerm: '', appliedRelations: [] }),
    expandQuery: vi.fn().mockResolvedValue({ originalQuery: '', expandedTerms: [], rewrittenQuery: '' }),
    getRelations: vi.fn().mockResolvedValue(relations),
    suggestSynonyms: vi.fn().mockResolvedValue([]),
    exportJson: vi.fn().mockResolvedValue({}),
    importJson: vi.fn(),
  };
}

const ranking: PPRResult = {
  rankedPassages: [],
  rankedEntities: [],
  iterations: 10,
  converged: true,
  l1Delta: 1e-7,
};

const query: QueryRequest = {
  corpusId: 'test',
  text: 'Who was Einstein?',
  topK: 10,
  topM: 5,
  threshold: 0.5,
  contextTokenLimit: 4000,
};

describe('AliasAwareContextBuilder', () => {
  it('returns base context when no dictionary matches', async () => {
    const builder = new AliasAwareContextBuilder(
      mockInnerBuilder(),
      mockDictionary([]),
      mockThesaurus(),
    );
    const result = await builder.build(query, ranking);
    expect(result.promptContext).toBe(baseBundle.promptContext);
    expect(result.metadata?.aliasHintCount).toBeUndefined();
  });

  it('prepends alias hints from dictionary entries', async () => {
    const entry = makeEntry();
    const builder = new AliasAwareContextBuilder(
      mockInnerBuilder(),
      mockDictionary([{ entry, matchedText: 'Einstein', boostFactor: 1.5 }]),
      mockThesaurus(),
    );
    const result = await builder.build(query, ranking);
    expect(result.promptContext).toContain('Entity Aliases');
    expect(result.promptContext).toContain('A. Einstein');
    expect(result.metadata?.aliasHintCount).toBe(1);
  });

  it('includes thesaurus synonyms in alias hints', async () => {
    const entry = makeEntry({ aliases: [] });
    const synonymRelation: ThesaurusRelation = {
      relationId: 'r1',
      sourceTerm: 'Albert Einstein',
      targetTerm: 'Einstein, Albert',
      relationType: 'synonym',
      language: 'en',
      weight: 0.9,
      bidirectional: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const builder = new AliasAwareContextBuilder(
      mockInnerBuilder(),
      mockDictionary([{ entry, matchedText: 'Einstein', boostFactor: 1.5 }]),
      mockThesaurus([synonymRelation]),
    );
    const result = await builder.build(query, ranking);
    expect(result.promptContext).toContain('Einstein, Albert');
    expect(result.metadata?.aliasHintCount).toBe(1);
  });

  it('skips entities with no aliases', async () => {
    const entry = makeEntry({ aliases: [], canonicalForm: 'Einstein' });
    const builder = new AliasAwareContextBuilder(
      mockInnerBuilder(),
      mockDictionary([{ entry, matchedText: 'Einstein', boostFactor: 1.5 }]),
      mockThesaurus(),
    );
    const result = await builder.build(query, ranking);
    expect(result.promptContext).toBe(baseBundle.promptContext);
  });
});
