/**
 * Contract test suite for IMemoryStore implementations.
 */

import { it, expect, beforeEach, afterEach } from 'vitest';
import type { IMemoryStore } from '../../src/domain/storage/graphStore.js';
import type { MemorySnapshot } from '../../src/domain/memory/globalMemory.js';
import type { Schema } from '../../src/domain/memory/schema.js';
import type { Fact } from '../../src/domain/memory/fact.js';
import type { Passage } from '../../src/domain/memory/passage.js';

const CORPUS = 'corpus-1';
const TS = '2025-01-01T00:00:00.000Z';

function createSchema(): Schema {
  return {
    schemaId: 'schema-1', corpusId: CORPUS,
    headType: 'Author', relation: 'writes', tailType: 'Paper',
    canonicalKey: 'author::writes::paper',
    aliases: [{ label: 'Author writes Paper', language: 'en', source: 'manual', confidence: 1, isCanonical: true }],
    frequency: 3, state: 'stable', stabilizationThreshold: 2,
    factIds: ['fact-1'], sourceDocumentIds: ['doc-1'],
    version: 2, createdAt: TS, updatedAt: TS,
  };
}

function createFact(): Fact {
  return {
    factId: 'fact-1', corpusId: CORPUS, schemaId: 'schema-1',
    headEntity: 'Ada Lovelace', headType: 'Author', relation: 'writes',
    tailEntity: 'Notes', tailType: 'Paper', state: 'active',
    passageIds: ['passage-1'], sourceDocumentIds: ['doc-1'],
    confidence: 0.96, temporalScope: '1843', createdAt: TS, updatedAt: TS,
  };
}

function createPassage(): Passage {
  return {
    passageId: 'passage-1', corpusId: CORPUS,
    text: 'Ada Lovelace wrote notes on the Analytical Engine.',
    normalizedText: 'ada lovelace wrote notes on the analytical engine',
    metadata: {
      documentId: 'doc-1', title: 'Notes', sourceUrl: 'https://example.com',
      sourceType: 'md', language: 'en', convertedAt: TS,
      sectionPath: ['Intro'], chunkId: 'chunk-1', chunkIndex: 0, offsetStart: 0, offsetEnd: 52,
    },
    factIds: ['fact-1'], entityMentions: ['Ada Lovelace', 'Analytical Engine'],
    qualityFlags: [], qualityScore: 0.88, createdAt: TS, updatedAt: TS,
  };
}

function createSnapshot(): MemorySnapshot {
  return {
    corpusId: CORPUS, exportedAt: TS,
    schemas: [createSchema()], facts: [createFact()], passages: [createPassage()],
    schemaVersion: 1,
  };
}

export interface MemoryStoreFactory {
  create(): Promise<IMemoryStore>;
  teardown(): Promise<void>;
}

export function memoryStoreContractTests(factory: MemoryStoreFactory): void {
  let store: IMemoryStore;

  beforeEach(async () => { store = await factory.create(); });
  afterEach(async () => { await factory.teardown(); });

  it('round-trips a snapshot (save → load)', async () => {
    const snapshot = createSnapshot();
    await store.save(snapshot);
    const loaded = await store.load(CORPUS);

    expect(loaded.corpusId).toBe(CORPUS);
    expect(loaded.schemas).toHaveLength(1);
    expect(loaded.schemas[0]).toMatchObject({ schemaId: 'schema-1', headType: 'Author' });
    expect(loaded.facts).toHaveLength(1);
    expect(loaded.facts[0]).toMatchObject({ factId: 'fact-1', headEntity: 'Ada Lovelace' });
    expect(loaded.passages).toHaveLength(1);
    expect(loaded.passages[0]).toMatchObject({ passageId: 'passage-1' });
  });

  it('upserts updated entities on re-save', async () => {
    await store.save(createSnapshot());

    const updated: MemorySnapshot = {
      ...createSnapshot(),
      schemas: [{ ...createSchema(), frequency: 10 }],
      facts: [{ ...createFact(), confidence: 0.5 }],
    };
    await store.save(updated);
    const loaded = await store.load(CORPUS);

    expect(loaded.schemas[0]?.frequency).toBe(10);
    expect(loaded.facts[0]?.confidence).toBe(0.5);
  });

  it('persists and loads job checkpoints', async () => {
    await store.saveCheckpoint({
      jobId: 'job-1', corpusId: CORPUS,
      processedDocumentIds: ['doc-1', 'doc-2'], updatedAt: TS,
    });

    const cp = await store.loadCheckpoint('job-1');
    expect(cp).toEqual({
      jobId: 'job-1', corpusId: CORPUS,
      processedDocumentIds: ['doc-1', 'doc-2'], updatedAt: TS,
    });

    expect(await store.loadCheckpoint('nonexistent')).toBeNull();
  });

  it('returns empty snapshot for unknown corpus', async () => {
    const loaded = await store.load('nonexistent');
    expect(loaded.schemas).toHaveLength(0);
    expect(loaded.facts).toHaveLength(0);
    expect(loaded.passages).toHaveLength(0);
  });
}
