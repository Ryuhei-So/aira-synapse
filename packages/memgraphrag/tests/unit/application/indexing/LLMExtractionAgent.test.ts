import { describe, it, expect } from 'vitest';
import type { ExtractionChunk } from '../../../../src/domain/agent/index.js';
import type { ILLMProvider } from '../../../../src/domain/provider/index.js';
import { LLMExtractionAgent } from '../../../../src/application/indexing/LLMExtractionAgent.js';

function chunk(): ExtractionChunk {
  return {
    chunkId: 'doc-1:0',
    corpusId: 'corpus-1',
    documentId: 'doc-1',
    text: 'Aspirin reduces fever.',
    normalizedText: 'Aspirin reduces fever.',
    language: 'en',
    metadata: {},
  } as ExtractionChunk;
}

function llmReturning(payload: unknown): ILLMProvider {
  return {
    generate: async () => ({ text: JSON.stringify(payload), model: 'test', tokensUsed: 0 }),
  } as unknown as ILLMProvider;
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
    ['string', { confidence: '0.9' }],
    ['NaN', { confidence: Number.NaN }],
    ['Infinity', { confidence: Number.POSITIVE_INFINITY }],
    ['negative', { confidence: -0.1 }],
    ['above one', { confidence: 1.5 }],
  ])('drops a relation whose confidence is %s', async (_label, override) => {
    const payload = { entities: [], relations: [relation(override)] };
    const agent = new LLMExtractionAgent(llmReturning(payload));

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

  it('emits only relations that satisfy the storage domain contract', async () => {
    const agent = new LLMExtractionAgent(llmReturning({
      entities: [],
      relations: [relation(), relation({ head: 'Bad', confidence: undefined })],
    }));

    const record = await agent.extract(chunk());

    // Every emitted alias must carry the finite confidence the Schema contract
    // requires — that check is what failed in production, one layer later.
    for (const candidate of record.candidateSchemas) {
      for (const alias of candidate.aliases) {
        expect(Number.isFinite(alias.confidence)).toBe(true);
      }
    }
    expect(record.candidateFacts).toHaveLength(1);
    expect(
      record.candidateFacts.every((fact) => Number.isFinite(fact.confidence)),
    ).toBe(true);
  });
});
