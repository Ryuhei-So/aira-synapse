import { describe, expect, it, vi } from 'vitest';

import type { Fact } from '../../../../../src/domain/memory/fact.js';
import type { MemorySnapshot } from '../../../../../src/domain/memory/globalMemory.js';
import type { SchemaAlias } from '../../../../../src/domain/memory/schema.js';
import { AiraGraphDbMemoryStore } from '../../../../../src/infrastructure/storage/aira-graphdb/AiraGraphDbAdapters.js';
import type { AiraGraphDbNativeClient } from '../../../../../src/infrastructure/storage/aira-graphdb/NativeClient.js';

const CORPUS_ID = 'contract-test';
const TS = '2026-01-01T00:00:00.000Z';

function snapshot(overrides: Partial<MemorySnapshot>): MemorySnapshot {
  return {
    corpusId: CORPUS_ID,
    exportedAt: TS,
    schemas: [],
    facts: [],
    passages: [],
    schemaVersion: 1,
    ...overrides,
  };
}

describe('AiraGraphDbMemoryStore', () => {
  it('rejects missing alias or fact confidence before any native request', async () => {
    const request = vi.fn(async () => {
      throw new Error('unexpected native request');
    });
    const store = new AiraGraphDbMemoryStore({ request } as unknown as AiraGraphDbNativeClient);
    const missingAliasConfidence = {
      label: 'Author', language: 'en', source: 'llm', isCanonical: true,
    } as unknown as SchemaAlias;
    const missingFactConfidence = {
      factId: 'f1', corpusId: CORPUS_ID, schemaId: 's1',
      headEntity: 'Alice', headType: 'person', relation: 'authors',
      tailEntity: 'Paper', tailType: 'paper', state: 'inactive',
      passageIds: ['p1'], sourceDocumentIds: ['doc-1'],
      createdAt: TS, updatedAt: TS,
    } as unknown as Fact;
    const invalidSnapshots = [
      snapshot({
        schemas: [{
          schemaId: 's1', corpusId: CORPUS_ID,
          headType: 'person', relation: 'authors', tailType: 'paper',
          canonicalKey: 'person::authors::paper', aliases: [missingAliasConfidence],
          frequency: 1, state: 'pending', stabilizationThreshold: 2,
          factIds: [], sourceDocumentIds: ['doc-1'], version: 1,
          createdAt: TS, updatedAt: TS,
        }],
      }),
      snapshot({ facts: [missingFactConfidence] }),
    ];

    for (const invalidSnapshot of invalidSnapshots) {
      await expect(store.save(invalidSnapshot)).rejects.toThrow(/confidence/);
    }
    expect(request).not.toHaveBeenCalled();
  });
});
