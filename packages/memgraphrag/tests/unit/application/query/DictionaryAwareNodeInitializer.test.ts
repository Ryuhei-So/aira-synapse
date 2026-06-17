/**
 * Tests for DictionaryAwareNodeInitializer (T-010).
 */
import { describe, it, expect, vi } from 'vitest';
import { DictionaryAwareNodeInitializer } from '../../../../src/application/query/DictionaryAwareNodeInitializer.js';
import type { INodeInitializer, NodeInitializationRequest, NodeInitializationVector } from '../../../../src/domain/retrieval/memoryFilter.js';
import type { ITermDictionary, DictionaryMatch, TermDictionaryEntry } from '../../../../src/domain/dictionary/termDictionary.js';
import type { IMemoryStore } from '../../../../src/domain/storage/index.js';
import type { Fact } from '../../../../src/domain/memory/fact.js';

function makeEntry(overrides: Partial<TermDictionaryEntry> = {}): TermDictionaryEntry {
  return {
    termId: 'lex:test:einstein',
    term: 'Einstein',
    canonicalForm: 'Albert Einstein',
    domainCategory: 'science',
    aliases: [],
    frequency: 5,
    confidence: 0.9,
    source: 'llm_extraction',
    version: '1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeFact(id: string, head: string, tail: string): Fact {
  return {
    factId: id,
    schemaId: 's1',
    headEntity: head,
    headType: 'entity',
    relation: 'related_to',
    tailEntity: tail,
    tailType: 'entity',
    state: 'active',
    passageIds: [],
    sourceDocumentIds: [],
    confidence: 0.9,
    corpusId: 'test-corpus',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeBaseVector(scores: Record<string, number>): NodeInitializationVector {
  return { scores, fallbackTriggered: false };
}

function mockInitializer(vector: NodeInitializationVector): INodeInitializer {
  return { initialize: vi.fn().mockResolvedValue(vector) };
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

function mockMemoryStore(facts: Fact[]): IMemoryStore {
  return {
    load: vi.fn().mockResolvedValue({
      corpusId: 'test-corpus',
      facts,
      passages: [],
      schemas: [],
      entities: [],
    }),
    save: vi.fn(),
    saveCheckpoint: vi.fn(),
    loadCheckpoint: vi.fn().mockResolvedValue(null),
    validateIntegrity: vi.fn().mockResolvedValue([]),
  };
}

describe('DictionaryAwareNodeInitializer', () => {
  it('returns base vector when no dictionary matches', async () => {
    const base = makeBaseVector({ 'fact:f1': 0.8 });
    const init = new DictionaryAwareNodeInitializer(
      mockInitializer(base),
      mockDictionary([]),
      mockMemoryStore([]),
    );

    const result = await init.initialize({
      query: { corpusId: 'test-corpus', text: 'test query', topK: 10, topM: 5, threshold: 0.5, contextTokenLimit: 4000 },
      candidates: { ontology: [], facts: [], passages: [], expandedTerms: [], fallbackRequired: false },
    });

    expect(result).toEqual(base);
    expect(result.injectedCount).toBeUndefined();
  });

  it('skips low-confidence dictionary matches', async () => {
    const base = makeBaseVector({ 'fact:f1': 0.8 });
    const lowConfEntry = makeEntry({ confidence: 0.3 });
    const init = new DictionaryAwareNodeInitializer(
      mockInitializer(base),
      mockDictionary([{ entry: lowConfEntry, matchedText: 'Einstein', boostFactor: 1.5 }]),
      mockMemoryStore([makeFact('f2', 'Albert Einstein', 'physics')]),
    );

    const result = await init.initialize({
      query: { corpusId: 'test-corpus', text: 'Einstein', topK: 10, topM: 5, threshold: 0.5, contextTokenLimit: 4000 },
      candidates: { ontology: [], facts: [], passages: [], expandedTerms: [], fallbackRequired: false },
    });

    expect(result).toEqual(base);
  });

  it('injects facts matching dictionary entities', async () => {
    const base = makeBaseVector({ 'fact:f1': 0.8 });
    const entry = makeEntry();
    const init = new DictionaryAwareNodeInitializer(
      mockInitializer(base),
      mockDictionary([{ entry, matchedText: 'Einstein', boostFactor: 1.5 }]),
      mockMemoryStore([
        makeFact('f1', 'Albert Einstein', 'physics'), // already in base
        makeFact('f2', 'Albert Einstein', 'Nobel Prize'), // should be injected
        makeFact('f3', 'unrelated', 'thing'), // should not be injected
      ]),
    );

    const result = await init.initialize({
      query: { corpusId: 'test-corpus', text: 'Einstein', topK: 10, topM: 5, threshold: 0.5, contextTokenLimit: 4000 },
      candidates: { ontology: [], facts: [], passages: [], expandedTerms: [], fallbackRequired: false },
    });

    expect(result.injectedCount).toBe(1);
    expect(result.scores['fact:f2']).toBeGreaterThan(0);
    expect(result.scores['fact:f3']).toBeUndefined();
    // L1 normalized
    const sum = Object.values(result.scores).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 5);
  });

  it('respects MAX_PER_ENTITY cap', async () => {
    const base = makeBaseVector({ 'fact:f0': 0.5 });
    const entry = makeEntry();
    const facts = Array.from({ length: 15 }, (_, i) =>
      makeFact(`inject-${i}`, 'Albert Einstein', `relation-${i}`),
    );

    const init = new DictionaryAwareNodeInitializer(
      mockInitializer(base),
      mockDictionary([{ entry, matchedText: 'Einstein', boostFactor: 1.5 }]),
      mockMemoryStore(facts),
    );

    const result = await init.initialize({
      query: { corpusId: 'test-corpus', text: 'Einstein', topK: 10, topM: 5, threshold: 0.5, contextTokenLimit: 4000 },
      candidates: { ontology: [], facts: [], passages: [], expandedTerms: [], fallbackRequired: false },
    });

    // Default MAX_PER_ENTITY=3, so only 3 injected
    expect(result.injectedCount).toBe(3);
  });
});
