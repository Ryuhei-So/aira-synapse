import { describe, expect, it, vi } from 'vitest';

import { INDEXING_MEMORY_CONTRACT } from '../../../../../src/domain/storage/indexingMemory.js';
import { MEMORY_DELETE_DOCUMENT_COUNT_KEYS } from '../../../../../src/domain/storage/documentReplace.js';
import { SCHEMA_CANONICALIZATION_CONTRACT } from '../../../../../src/domain/storage/schemaCanonicalization.js';
import {
  AiraGraphDbDocumentReplaceMemory,
  validateMemoryDeleteDocumentResult,
} from '../../../../../src/infrastructure/storage/aira-graphdb/AiraGraphDbAdapters.js';
import { AiraGraphDbIndexingMemory } from '../../../../../src/infrastructure/storage/aira-graphdb/AiraGraphDbIndexingMemory.js';
import type { AiraGraphDbRpcClient } from '../../../../../src/infrastructure/storage/aira-graphdb/NativeClient.js';

const REQUEST = { corpusId: 'c1', documentId: 'doc_w', updatedAt: '2026-10-11T00:00:00.000Z' };

function counts(value = 0): Record<string, number> {
  return Object.fromEntries(MEMORY_DELETE_DOCUMENT_COUNT_KEYS.map((key) => [key, value]));
}

function result(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { corpusId: 'c1', documentId: 'doc_w', noop: false, ...counts(1), ...overrides };
}

function protocolInfo(extraMethods: readonly Record<string, unknown>[]): Record<string, unknown> {
  return {
    protocolVersion: 'native-method-policy@1',
    generation: 0,
    state: 'idle',
    limits: {
      indexingMemory: { ...INDEXING_MEMORY_CONTRACT, schemaCanonicalization: SCHEMA_CANONICALIZATION_CONTRACT },
      wal: { mutationRequestIdUniqueness: 'activeTransaction' },
    },
    methods: [
      { name: 'memory_get_schemas_by_ids', classification: 'read', wal: false },
      { name: 'memory_get_active_facts', classification: 'read', wal: false },
      { name: 'memory_activate_facts_by_schema_ids', classification: 'mutation', wal: true },
      { name: 'memory_upsert', classification: 'mutation', wal: true },
      { name: 'upsert_nodes', classification: 'mutation', wal: true },
      ...extraMethods,
    ],
  };
}

describe('memory_delete_document adapter (literature-hub #614)', () => {
  it('sends exactly {corpusId, documentId, updatedAt} and returns the flat counts', async () => {
    const request = vi.fn(async () => result());
    const memory = new AiraGraphDbDocumentReplaceMemory({ request } as unknown as AiraGraphDbRpcClient);
    await expect(memory.memoryDeleteDocument(REQUEST)).resolves.toEqual(result());
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith('memory_delete_document', REQUEST, {
      maxRequestBytes: INDEXING_MEMORY_CONTRACT.maxRequestBytes,
      maxResponseBytes: INDEXING_MEMORY_CONTRACT.maxResponseBytes,
    });
  });

  it('accepts a noop for an absent document', () => {
    expect(validateMemoryDeleteDocumentResult(result({ noop: true, ...counts(0) }), REQUEST).noop).toBe(true);
  });

  it.each([
    ['a non-object', null],
    ['an extra key', result({ extra: 1 })],
    ['a missing count', (() => { const r = result(); delete r.rekeyedVectors; return r; })()],
    ['another document', result({ documentId: 'doc_x' })],
    ['another corpus', result({ corpusId: 'c2' })],
    ['a negative count', result({ removedFacts: -1 })],
    ['a fractional count', result({ removedFacts: 1.5 })],
    ['noop with counts', result({ noop: true })],
    ['no noop without counts', result({ noop: false, ...counts(0) })],
    ['a non-boolean noop', result({ noop: 'false' })],
  ])('fails closed on %s', (_label, value) => {
    expect(() => validateMemoryDeleteDocumentResult(value, REQUEST)).toThrow(/memory_delete_document/);
  });

  it.each([
    ['an empty documentId', { ...REQUEST, documentId: '' }],
    ['an empty updatedAt', { ...REQUEST, updatedAt: '' }],
    ['an oversized corpusId', { ...REQUEST, corpusId: 'c'.repeat(INDEXING_MEMORY_CONTRACT.maxCorpusIdBytes + 1) }],
  ])('rejects %s before any RPC', async (_label, bad) => {
    const request = vi.fn();
    const memory = new AiraGraphDbDocumentReplaceMemory({ request } as unknown as AiraGraphDbRpcClient);
    await expect(memory.memoryDeleteDocument(bad)).rejects.toThrow(/memory_delete_document/);
    expect(request).not.toHaveBeenCalled();
  });

  it('detects the advertised method from the existing protocol_info read, without requiring it', async () => {
    const without = await AiraGraphDbIndexingMemory.create({
      request: vi.fn(async () => protocolInfo([])),
    } as unknown as AiraGraphDbRpcClient);
    expect(without.supportsMemoryDeleteDocument).toBe(false);

    const advertised = await AiraGraphDbIndexingMemory.create({
      request: vi.fn(async () => protocolInfo([{ name: 'memory_delete_document', classification: 'mutation', wal: true }])),
    } as unknown as AiraGraphDbRpcClient);
    expect(advertised.supportsMemoryDeleteDocument).toBe(true);

    for (const drift of [
      { name: 'memory_delete_document', classification: 'read', wal: false },
      { name: 'memory_delete_document', classification: 'mutation', wal: false },
    ]) {
      await expect(AiraGraphDbIndexingMemory.create({
        request: vi.fn(async () => protocolInfo([drift])),
      } as unknown as AiraGraphDbRpcClient)).rejects.toThrow(/method contract mismatch for memory_delete_document/);
    }
  });
});
