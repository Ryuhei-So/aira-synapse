import { describe, it, expect } from 'vitest';
import { DefaultRRFMerger } from '../../src/application/query/DefaultRRFMerger.js';
import type { NamespacedRetrievedContext, RRFConfig } from '../../src/application/query/federationTypes.js';
import type { RetrievedQueryContext } from '../../src/domain/retrieval/federation.js';
import type { Passage } from '../../src/domain/memory/passage.js';
import type { Fact } from '../../src/domain/memory/fact.js';

function makePassage(id: string, text: string, sourceUrl: string): Passage {
  return {
    passageId: id,
    text,
    normalizedText: text.toLowerCase(),
    metadata: {
      documentId: `doc-${id}`,
      title: `Title ${id}`,
      sourceUrl,
      language: 'en',
      sectionPath: [],
      chunkId: id,
      chunkIndex: 0,
      offsetStart: 0,
      offsetEnd: text.length,
    },
    corpusId: 'test',
    factIds: [],
    entityMentions: [],
    qualityFlags: [],
    createdAt: '',
    updatedAt: '',
  };
}

function makeFact(id: string): Fact {
  return {
    factId: id,
    schemaId: `schema-${id}`,
    headEntity: 'A',
    headType: 'Entity',
    relation: 'relatedTo',
    tailEntity: 'B',
    tailType: 'Entity',
    state: 'active',
    passageIds: [],
    sourceDocumentIds: [],
    confidence: 0.9,
    corpusId: 'test',
    createdAt: '',
    updatedAt: '',
  };
}

function makeContext(passages: { id: string; text: string; url: string }[], facts?: { id: string }[]): RetrievedQueryContext {
  return {
    passages: passages.map((p, i) => ({
      passage: makePassage(p.id, p.text, p.url),
      score: 1 - i * 0.1,
      rank: i + 1,
    })),
    facts: (facts ?? []).map((f, i) => ({
      fact: makeFact(f.id),
      score: 1 - i * 0.1,
      rank: i + 1,
    })),
    pprResult: { rankedPassages: [], rankedEntities: [], iterations: 5, converged: true, l1Delta: 0 },
    contextBundle: { promptContext: '', citedPassages: [], citedFacts: [], confidence: 0 },
    normalizedText: 'test query',
    expandedRequest: { corpusId: 'test', text: 'test query', topK: 10, topM: 5, threshold: 0.5, contextTokenLimit: 3000 },
    entityHits: [],
    dictionaryHints: '',
    isComparison: false,
    queryVector: [0.1, 0.2],
    metrics: { dictionaryMatchCount: 0, expandedTerms: [], fallbackTriggered: false, pprIterations: 5, pprConverged: true, citedPassageCount: passages.length, latencyMs: 100 },
  };
}

const defaultConfig: RRFConfig = { k: 60, globalTopK: 10, maxContributionRatio: 0.7, contextTokenBudget: 3000 };

describe('DefaultRRFMerger', () => {
  const merger = new DefaultRRFMerger();

  it('merges two contexts with correct RRF scoring', () => {
    const ctx1 = makeContext([
      { id: 'p1', text: 'passage one text', url: 'http://a.com/1' },
      { id: 'p2', text: 'passage two text', url: 'http://a.com/2' },
    ]);
    const ctx2 = makeContext([
      { id: 'p3', text: 'passage three text', url: 'http://b.com/1' },
    ]);

    const contexts: NamespacedRetrievedContext[] = [
      { dbId: 'db1', context: ctx1, weight: 1.0 },
      { dbId: 'db2', context: ctx2, weight: 1.0 },
    ];

    const result = merger.merge(contexts, defaultConfig);
    expect(result.mergedPassages).toHaveLength(3);
    expect(result.mergedPassages[0]!.rrfScore).toBeCloseTo(1 / 61); // rank 1 → 1/(60+1)
    expect(result.dbContributions['db1']).toBe(2);
    expect(result.dbContributions['db2']).toBe(1);
    expect(result.deduplicatedCount).toBe(0);
  });

  it('deduplicates passages with same sourceUrl + text', () => {
    const ctx1 = makeContext([{ id: 'p1', text: 'same text', url: 'http://same.com' }]);
    const ctx2 = makeContext([{ id: 'p2', text: 'same text', url: 'http://same.com' }]);

    const result = merger.merge([
      { dbId: 'db1', context: ctx1, weight: 1.0 },
      { dbId: 'db2', context: ctx2, weight: 1.0 },
    ], defaultConfig);

    expect(result.mergedPassages).toHaveLength(1);
    expect(result.deduplicatedCount).toBe(1);
  });

  it('keeps passages with same URL but different text', () => {
    const ctx1 = makeContext([{ id: 'p1', text: 'chunk one', url: 'http://same.com' }]);
    const ctx2 = makeContext([{ id: 'p2', text: 'chunk two', url: 'http://same.com' }]);

    const result = merger.merge([
      { dbId: 'db1', context: ctx1, weight: 1.0 },
      { dbId: 'db2', context: ctx2, weight: 1.0 },
    ], defaultConfig);

    expect(result.mergedPassages).toHaveLength(2);
    expect(result.deduplicatedCount).toBe(0);
  });

  it('applies contribution cap when multiple DBs', () => {
    // DB1 has many passages, DB2 has one
    const longText = 'x'.repeat(4000); // ~1000 tokens
    const ctx1 = makeContext([
      { id: 'p1', text: longText, url: 'http://a.com/1' },
      { id: 'p2', text: longText, url: 'http://a.com/2' },
      { id: 'p3', text: longText, url: 'http://a.com/3' },
    ]);
    const ctx2 = makeContext([
      { id: 'p4', text: 'short', url: 'http://b.com/1' },
    ]);

    const result = merger.merge([
      { dbId: 'db1', context: ctx1, weight: 1.0 },
      { dbId: 'db2', context: ctx2, weight: 1.0 },
    ], { ...defaultConfig, maxContributionRatio: 0.7, contextTokenBudget: 3000 });

    // DB1 max tokens = 3000 * 0.7 = 2100, each passage ~1000 tokens → max 2
    const db1Count = result.mergedPassages.filter((p) => p.sourceDbId === 'db1').length;
    expect(db1Count).toBeLessThanOrEqual(2);
  });

  it('relaxes contribution cap when single DB', () => {
    const longText = 'x'.repeat(4000);
    const ctx1 = makeContext([
      { id: 'p1', text: longText, url: 'http://a.com/1' },
      { id: 'p2', text: longText, url: 'http://a.com/2' },
      { id: 'p3', text: longText, url: 'http://a.com/3' },
    ]);

    const result = merger.merge([
      { dbId: 'db1', context: ctx1, weight: 1.0 },
    ], { ...defaultConfig, maxContributionRatio: 0.7, contextTokenBudget: 3000 });

    // Single DB → no cap
    expect(result.mergedPassages).toHaveLength(3);
  });

  it('applies weights to RRF scores', () => {
    const ctx1 = makeContext([{ id: 'p1', text: 'text a', url: 'http://a.com' }]);
    const ctx2 = makeContext([{ id: 'p2', text: 'text b', url: 'http://b.com' }]);

    const result = merger.merge([
      { dbId: 'db1', context: ctx1, weight: 2.0 },
      { dbId: 'db2', context: ctx2, weight: 1.0 },
    ], defaultConfig);

    expect(result.mergedPassages[0]!.sourceDbId).toBe('db1');
    expect(result.mergedPassages[0]!.rrfScore).toBeCloseTo(2.0 / 61);
  });

  it('rebuilds contextBundle invariants', () => {
    const ctx1 = makeContext([{ id: 'p1', text: 'passage text', url: 'http://a.com' }]);
    const result = merger.merge([{ dbId: 'db1', context: ctx1, weight: 1.0 }], defaultConfig);

    expect(result.contextBundle.citedPassages).toHaveLength(1);
    expect(result.contextBundle.citedPassages[0]!.passageId).toBe('p1');
    expect(result.contextBundle.promptContext).toContain('Passage: passage text');
    expect(result.passages[0]!.dbId).toBe('db1');
    expect(result.passages[0]!.rank).toBe(1);
  });

  it('respects globalTopK limit', () => {
    const passages = Array.from({ length: 20 }, (_, i) => ({
      id: `p${i}`, text: `text ${i}`, url: `http://a.com/${i}`,
    }));
    const ctx = makeContext(passages);
    const result = merger.merge(
      [{ dbId: 'db1', context: ctx, weight: 1.0 }],
      { ...defaultConfig, globalTopK: 5 },
    );
    expect(result.mergedPassages).toHaveLength(5);
  });

  it('throws on empty contexts', () => {
    expect(() => merger.merge([], defaultConfig)).toThrow('Cannot merge zero contexts');
  });

  it('merges facts with RRF scoring', () => {
    const ctx1 = makeContext(
      [{ id: 'p1', text: 'text', url: 'http://a.com' }],
      [{ id: 'f1' }, { id: 'f2' }],
    );
    const ctx2 = makeContext(
      [{ id: 'p2', text: 'text2', url: 'http://b.com' }],
      [{ id: 'f3' }],
    );

    const result = merger.merge([
      { dbId: 'db1', context: ctx1, weight: 1.0 },
      { dbId: 'db2', context: ctx2, weight: 1.0 },
    ], defaultConfig);

    expect(result.mergedFacts).toHaveLength(3);
    expect(result.facts[0]!.rank).toBe(1);
  });
});
