/**
 * Contract test suite for IVectorIndex implementations.
 * Any implementation (FileVectorIndex, LadybugVectorIndex) must pass all of these.
 */

import { it, expect, beforeEach, afterEach } from 'vitest';
import type { IVectorIndex, VectorRecord } from '../../src/domain/storage/graphStore.js';

const CORPUS = 'corpus-1';

function makeRecord(
  id: string,
  values: number[],
  namespace: 'schema' | 'fact' | 'passage' | 'entity' = 'fact',
  corpusId = CORPUS,
): VectorRecord<{ documentId: string }> {
  return { id, corpusId, namespace, values, metadata: { documentId: 'doc-1' } };
}

export interface VectorIndexFactory {
  create(): Promise<IVectorIndex>;
  teardown(): Promise<void>;
  /** The minimum vector dimension supported by the implementation. */
  vectorDim: number;
}

export function vectorIndexContractTests(factory: VectorIndexFactory): void {
  let index: IVectorIndex;

  beforeEach(async () => { index = await factory.create(); });
  afterEach(async () => { await factory.teardown(); });

  function vec(...components: number[]): number[] {
    const v = new Array(factory.vectorDim).fill(0);
    for (let i = 0; i < components.length && i < v.length; i++) v[i] = components[i]!;
    return v;
  }

  it('stores and retrieves vectors with correct ranking', async () => {
    await index.upsert([
      makeRecord('v1', vec(1, 0, 0)),
      makeRecord('v2', vec(0, 1, 0)),
      makeRecord('v3', vec(0, 0, 1)),
    ]);

    const results = await index.search({
      corpusId: CORPUS, namespace: 'fact', queryVector: vec(1, 0, 0), topK: 3,
    });

    expect(results.length).toBe(3);
    expect(results[0]!.id).toBe('v1');
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });

  it('respects topK limit', async () => {
    await index.upsert([
      makeRecord('v1', vec(1, 0, 0)),
      makeRecord('v2', vec(0.9, 0.1, 0)),
      makeRecord('v3', vec(0, 0, 1)),
    ]);

    const results = await index.search({
      corpusId: CORPUS, namespace: 'fact', queryVector: vec(1, 0, 0), topK: 1,
    });
    expect(results.length).toBe(1);
  });

  it('applies threshold filter', async () => {
    await index.upsert([
      makeRecord('v1', vec(1, 0, 0)),
      makeRecord('v2', vec(0, 1, 0)),
    ]);

    const results = await index.search({
      corpusId: CORPUS, namespace: 'fact', queryVector: vec(1, 0, 0), topK: 10, threshold: 0.9,
    });
    expect(results.length).toBe(1);
    expect(results[0]!.id).toBe('v1');
  });

  it('isolates namespaces', async () => {
    await index.upsert([makeRecord('v1', vec(1, 0, 0), 'fact')]);
    await index.upsert([makeRecord('v2', vec(1, 0, 0), 'schema')]);

    const facts = await index.search({ corpusId: CORPUS, namespace: 'fact', queryVector: vec(1, 0, 0), topK: 10 });
    const schemas = await index.search({ corpusId: CORPUS, namespace: 'schema', queryVector: vec(1, 0, 0), topK: 10 });

    expect(facts.length).toBe(1);
    expect(facts[0]!.id).toBe('v1');
    expect(schemas.length).toBe(1);
    expect(schemas[0]!.id).toBe('v2');
  });

  it('isolates corpora', async () => {
    await index.upsert([makeRecord('v1', vec(1, 0, 0), 'fact', 'corpus-1')]);
    await index.upsert([makeRecord('v2', vec(1, 0, 0), 'fact', 'corpus-2')]);

    const r1 = await index.search({ corpusId: 'corpus-1', namespace: 'fact', queryVector: vec(1, 0, 0), topK: 10 });
    const r2 = await index.search({ corpusId: 'corpus-2', namespace: 'fact', queryVector: vec(1, 0, 0), topK: 10 });

    expect(r1.length).toBe(1);
    expect(r1[0]!.id).toBe('v1');
    expect(r2.length).toBe(1);
    expect(r2[0]!.id).toBe('v2');
  });

  it('deletes vectors by document', async () => {
    await index.upsert([
      { ...makeRecord('v1', vec(1, 0, 0)), metadata: { documentId: 'doc-1' } },
      { ...makeRecord('v2', vec(0, 1, 0)), metadata: { documentId: 'doc-2' } },
    ]);

    await index.deleteByDocument(CORPUS, 'doc-1');

    const results = await index.search({ corpusId: CORPUS, namespace: 'fact', queryVector: vec(1, 0, 0), topK: 10 });
    expect(results.length).toBe(1);
    expect(results[0]!.id).toBe('v2');
  });

  it('replaces existing vector on re-upsert (idempotent)', async () => {
    await index.upsert([makeRecord('v1', vec(1, 0, 0))]);
    await index.upsert([makeRecord('v1', vec(0, 1, 0))]);

    const results = await index.search({ corpusId: CORPUS, namespace: 'fact', queryVector: vec(0, 1, 0), topK: 1 });
    expect(results[0]!.id).toBe('v1');
    expect(results[0]!.score).toBeGreaterThan(0.9);
  });

  it('returns empty results for non-existent corpus', async () => {
    const results = await index.search({ corpusId: 'nonexistent', namespace: 'fact', queryVector: vec(1, 0, 0), topK: 10 });
    expect(results).toEqual([]);
  });
}
