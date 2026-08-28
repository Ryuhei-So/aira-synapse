import { describe, it, expect, vi } from 'vitest';
import type { ExtractionChunk } from '../../../../src/domain/agent/index.js';
import type { ILLMProvider } from '../../../../src/domain/provider/index.js';
import { LLMExtractionAgent } from '../../../../src/application/indexing/LLMExtractionAgent.js';
import { validateDomainObject } from '../../../../src/domain/memory/domainContract.js';

function chunk(): ExtractionChunk {
  return {
    chunkId: 'doc-1:0',
    corpusId: 'corpus-1',
    documentId: 'doc-1',
    text: 'Aspirin reduces fever.',
    normalizedText: 'Aspirin reduces fever.',
    language: 'en',
    metadata: {
      documentId: 'doc-1',
      title: 'Document Title',
      sourceUrl: 'https://example.com/doc',
      sourceType: 'md',
      language: 'en',
      chunkIndex: 0,
      startOffset: 0,
      endOffset: 22,
      tokenCount: 5,
    },
  } as unknown as ExtractionChunk;
}

/** Returns the response body verbatim, so a test can emit JSON that
 *  JSON.stringify could never produce (NaN, Infinity, malformed text). */
function llmReturningRaw(text: string): ILLMProvider {
  return {
    generate: vi.fn(async () => ({
      text,
      model: 'test-model',
      usage: { inputTokens: 1, outputTokens: 1 },
    })),
    healthCheck: vi.fn(async () => true),
  } as unknown as ILLMProvider;
}

function llmReturning(payload: unknown): ILLMProvider {
  return llmReturningRaw(JSON.stringify(payload));
}

function relation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    head: 'Aspirin',
    headType: 'Drug',
    relation: 'reduces',
    tail: 'Fever',
    tailType: 'Symptom',
    confidence: 0.9,
    ...overrides,
  };
}

describe('LLMExtractionAgent confidence contract', () => {
  it('keeps a well-formed relation and carries its confidence through', async () => {
    const agent = new LLMExtractionAgent(llmReturning({ entities: [], relations: [relation()] }));

    const record = await agent.extract(chunk());

    expect(record.candidateFacts).toHaveLength(1);
    expect(record.candidateSchemas).toHaveLength(1);
    expect(record.candidateFacts[0]?.confidence).toBe(0.9);
    expect(record.candidateSchemas[0]?.aliases[0]?.confidence).toBe(0.9);
  });

  // Production 2026-08-28: gpt-5.6-luna emitted relations whose confidence was
  // missing or non-numeric. They flowed unchecked into schema aliases and facts
  // and were only caught at the storage contract, failing seven whole documents
  // ("$.confidence must be a finite number" / "$.aliases[0].confidence is
  // required"). The relation must be dropped at the parse boundary instead.
  it.each([
    ['missing', { confidence: undefined }],
    ['null', { confidence: null }],
    ['a string', { confidence: '0.9' }],
    ['a boolean', { confidence: true }],
    ['an object', { confidence: { value: 0.9 } }],
  ])('drops a relation whose confidence is %s', async (_label, override) => {
    const agent = new LLMExtractionAgent(llmReturning({ entities: [], relations: [relation(override)] }));

    const record = await agent.extract(chunk());

    expect(record.candidateFacts).toEqual([]);
    expect(record.candidateSchemas).toEqual([]);
  });

  // JSON.stringify turns NaN and Infinity into null, so these have to be built
  // as raw text or the Number.isFinite guard would never actually be exercised.
  it.each([
    ['Infinity via an overflowing literal', '1e999'],
    ['-Infinity via an overflowing literal', '-1e999'],
  ])('drops a relation whose confidence is %s', async (_label, literal) => {
    const agent = new LLMExtractionAgent(llmReturningRaw(
      `{"entities":[],"relations":[{"head":"A","headType":"T","relation":"r","tail":"B","tailType":"T","confidence":${literal}}]}`,
    ));

    const record = await agent.extract(chunk());

    expect(record.candidateFacts).toEqual([]);
    expect(record.candidateSchemas).toEqual([]);
  });

  it('drops only the offending relation and keeps the rest of the chunk', async () => {
    const agent = new LLMExtractionAgent(llmReturning({
      entities: [],
      relations: [
        relation({ head: 'Good' }),
        relation({ head: 'Bad', confidence: 'high' }),
        relation({ head: 'AlsoGood', confidence: 0.75 }),
      ],
    }));

    const record = await agent.extract(chunk());

    expect(record.candidateFacts.map((fact) => fact.headEntity)).toEqual(['Good', 'AlsoGood']);
  });

  it('never invents a confidence value for a relation the model did not score', async () => {
    const agent = new LLMExtractionAgent(llmReturning({
      entities: [],
      relations: [relation({ confidence: undefined })],
    }));

    const record = await agent.extract(chunk());

    // Defaulting would fabricate evidence strength that foldFact's Math.max
    // could then propagate as the winning value, with nothing recording that
    // it was invented. Dropping is the only provenance-safe outcome.
    expect(record.candidateFacts).toEqual([]);
    expect(record.candidateSchemas).toEqual([]);
  });

  // The storage contract accepts any finite confidence. Rejecting out-of-range
  // values here would mean a model that drifts to a 0-100 scale silently loses
  // every relation in every chunk, and the document is still banked as indexed.
  it('keeps a finite confidence outside 0-1 and reports the scale drift', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const agent = new LLMExtractionAgent(llmReturning({
        entities: [],
        relations: [relation({ confidence: 95 })],
      }));

      const record = await agent.extract(chunk());

      expect(record.candidateFacts).toHaveLength(1);
      expect(record.candidateFacts[0]?.confidence).toBe(95);
      expect(warn.mock.calls.flat().join(' ')).toContain('outside 0-1');
    } finally { warn.mockRestore(); }
  });

  it('reports why relations were dropped, and says so when none survive', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const agent = new LLMExtractionAgent(llmReturning({
        entities: [],
        relations: [relation({ confidence: undefined }), relation({ headType: 7 })],
      }));

      const record = await agent.extract(chunk());

      expect(record.candidateFacts).toEqual([]);
      const logged = warn.mock.calls.flat().join(' ');
      expect(logged).toContain('confidence:missing=1');
      expect(logged).toContain('headType:not-a-string=1');
      expect(logged).toContain('no usable relations');
    } finally { warn.mockRestore(); }
  });

  it('reports an unparseable response instead of silently extracting nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const agent = new LLMExtractionAgent(llmReturningRaw('Sure! Here are the relations: {"relations": ['));

      const record = await agent.extract(chunk());

      expect(record.candidateFacts).toEqual([]);
      expect(warn.mock.calls.flat().join(' ')).toContain('not parseable JSON');
    } finally { warn.mockRestore(); }
  });

  it('emits schemas and facts that satisfy the real storage domain contract', async () => {
    const agent = new LLMExtractionAgent(llmReturning({
      entities: [{ name: 'Aspirin', type: 'Drug' }],
      relations: [relation(), relation({ head: 'Bad', confidence: undefined })],
    }));

    const record = await agent.extract(chunk());

    expect(record.candidateFacts).toHaveLength(1);
    // Validate against the contract objects that actually rejected the
    // production payload, not a hand-rolled restatement of one field. The
    // candidates are promoted into their stored shapes exactly as the later
    // stages do, so a bad confidence surfaces here instead of in production.
    const stamps = { createdAt: '2026-08-28T00:00:00.000Z', updatedAt: '2026-08-28T00:00:00.000Z' };
    for (const candidate of record.candidateSchemas) {
      expect(validateDomainObject('schema', {
        corpusId: 'corpus-1',
        ...stamps,
        schemaId: 'schema:test',
        headType: candidate.headType,
        relation: candidate.relation,
        tailType: candidate.tailType,
        canonicalKey: candidate.canonicalKey,
        aliases: candidate.aliases,
        frequency: 1,
        state: 'pending',
        stabilizationThreshold: 2,
        factIds: [],
        sourceDocumentIds: ['doc-1'],
        version: 1,
      }).errors).toEqual([]);
    }
    for (const candidate of record.candidateFacts) {
      expect(validateDomainObject('fact', {
        corpusId: 'corpus-1',
        ...stamps,
        factId: 'fact:test',
        schemaId: 'schema:test',
        headEntity: candidate.headEntity,
        headType: candidate.headType,
        relation: candidate.relation,
        tailEntity: candidate.tailEntity,
        tailType: candidate.tailType,
        state: 'active',
        passageIds: candidate.supportingSpanIds,
        sourceDocumentIds: ['doc-1'],
        confidence: candidate.confidence,
      }).errors).toEqual([]);
    }
  });
});
