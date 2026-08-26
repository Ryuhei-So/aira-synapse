import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FullDocumentIndexingPipeline } from '../../../../src/application/indexing/FullDocumentIndexingPipeline.js';
import { DocumentMutationError } from '../../../../src/application/indexing/AsyncJobRunner.js';
import { BatchEmbeddingProvider } from '../../../../src/infrastructure/embedding/BatchEmbeddingProvider.js';
import { openDatabase, runMigrations } from '../../../../src/infrastructure/storage/migrate.js';
import { chunkMarkdownDocument, chunkMarkdownDocumentWithGinza, fallbackParagraphSplit, toExtractionChunk } from '../../../../src/application/indexing/MarkdownChunker.js';
import { validateDomainObject } from '../../../../src/domain/memory/domainContract.js';
import type { ILLMProvider } from '../../../../src/domain/provider/llmProvider.js';
import { computeCanonicalKey, normalizeSchemaTerm } from '../../../../src/domain/memory/schema.js';

function extractionResponse(relation = 'authors'): string {
  return JSON.stringify({
    entities: [{ name: 'Alice', type: 'Person' }, { name: 'Paper A', type: 'Paper' }],
    relations: [{
      head: 'Alice', headType: 'Person', relation, tail: 'Paper A',
      tailType: 'Paper', confidence: 0.9,
    }],
  });
}

function provider(text: string | readonly string[]): ILLMProvider {
  const responses = typeof text === 'string' ? [text] : [...text];
  let index = 0;
  return {
    generate: vi.fn().mockImplementation(async () => {
      const response = responses[Math.min(index, responses.length - 1)] ?? '';
      index += 1;
      return { text: response, model: 'test', usage: { inputTokens: 1, outputTokens: 1 } };
    }),
    healthCheck: vi.fn(),
  };
}

function mutationBoundaryHarness(
  llmProvider = provider(extractionResponse()),
  storedRelation = 'authors',
  options: {
    readonly storedFrequency?: number;
    readonly storedState?: 'pending' | 'stable';
    readonly trapStageVAccess?: boolean;
  } = {},
) {
  const mutationTrace: string[] = [];
  const dictionaryRead = vi.fn(() => {
    throw new Error('dictionary must not be read when Stage V is disabled');
  });
  const dictionaryFactoryRead = vi.fn(() => {
    throw new Error('dictionaryFactory must not be read when Stage V is disabled');
  });
  const db = openDatabase(':memory:');
  runMigrations(db);
  db.prepare('INSERT INTO corpora (corpus_id, name, description) VALUES (?, ?, ?)')
    .run('c1', 'Corpus 1', 'mutation boundary');
  const storedCanonicalKey = computeCanonicalKey('person', storedRelation, 'paper');
  const storedSchema = {
    schemaId: `schema:${storedCanonicalKey}`, corpusId: 'c1', headType: 'person',
    relation: normalizeSchemaTerm(storedRelation), tailType: 'paper', canonicalKey: storedCanonicalKey,
    aliases: [], frequency: options.storedFrequency ?? 1,
    state: options.storedState ?? 'pending', stabilizationThreshold: 2,
    factIds: [], sourceDocumentIds: ['old-doc'], version: 1,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const indexingMemory = {
    getSchemasByIds: vi.fn().mockResolvedValue([storedSchema]),
    getActiveFacts: vi.fn().mockResolvedValue([]),
    preflightMutation: vi.fn(() => { mutationTrace.push('preflight'); }),
    activateFactsBySchemaIds: vi.fn().mockImplementation(async () => {
      mutationTrace.push('activation');
      return 1;
    }),
    upsertDelta: vi.fn().mockImplementation(async () => {
      mutationTrace.push('memory');
    }),
  };
  const graphStore = {
    upsertNodes: vi.fn().mockImplementation(async () => {
      mutationTrace.push('graph_nodes');
    }),
    upsertEdges: vi.fn().mockImplementation(async () => {
      mutationTrace.push('graph_edges');
    }),
  };
  const vectorIndex = {
    upsert: vi.fn().mockImplementation(async () => {
      mutationTrace.push('vector');
    }),
  };
  const embeddingProvider = {
    embed: vi.fn().mockImplementation(async ({ texts }: { texts: readonly string[] }) => ({
      vectors: texts.map(() => [1]), model: 'test', cached: false,
    })),
    healthCheck: vi.fn(),
  };
  const pipelineOptions = {
    db,
    graphStore: graphStore as never,
    vectorIndex: vectorIndex as never,
    indexingMemory: indexingMemory as never,
    llmProvider,
    embeddingProvider: embeddingProvider as never,
    nlpExtractor: {
      extract: vi.fn().mockResolvedValue({ language: 'en', entities: [], nounPhrases: [] }),
      healthCheck: vi.fn(),
    } as never,
    enableDictionaryIndexing: false,
  };
  if (options.trapStageVAccess) {
    Object.setPrototypeOf(pipelineOptions, Object.create(Object.prototype, {
      dictionary: { configurable: true, get: dictionaryRead },
      dictionaryFactory: { configurable: true, get: dictionaryFactoryRead },
    }));
  }
  const pipeline = new FullDocumentIndexingPipeline(pipelineOptions);
  const run = (markdown = 'Alice authors Paper A.') => pipeline.processDocument('c1', {
    documentId: 'doc-boundary', markdown, title: 'Paper',
    sourceUrl: 'https://example.com/paper', language: 'en',
  });
  return {
    db,
    run,
    indexingMemory,
    graphStore,
    vectorIndex,
    embeddingProvider,
    mutationTrace,
    pipelineOptions,
    dictionaryRead,
    dictionaryFactoryRead,
  };
}

describe('indexing and provider behavioral boundaries', () => {
  it('chunks empty, heading, feature-rich, and oversized fallback markdown with stable metadata', () => {
    const base = { corpusId: 'c1', documentId: 'doc-1', title: 'Doc', sourceUrl: 'https://example.com', language: 'en' as const, markdown: '' };
    expect(chunkMarkdownDocument(base)).toEqual([]);
    const chunks = chunkMarkdownDocument({ ...base, markdown: '# Intro\nA table | value |\n\n## References\n[1] citation' });
    expect(chunks.map((x) => x.sectionPath)).toEqual([['Intro'], ['Intro', 'References']]);
    expect(chunks[1]?.features.hasReferences).toBe(true);
    expect(chunks[0]?.features.hasTable).toBe(true);
    const parts = fallbackParagraphSplit('one\n\ntwo\n\nthree', 2, 1);
    expect(parts).toEqual(['one\n\ntwo', 'two\n\nthree']);
    const extraction = toExtractionChunk('c1', chunks[0]!, { ...base, markdown: chunks[0]!.text });
    expect(extraction.metadata.chunkId).toBe(chunks[0]!.chunkId);
  });

  it('keeps jumped heading levels dense and omits absent optional metadata', () => {
    const request = {
      corpusId: 'c1', documentId: 'doc-jump', title: 'Title', sourceUrl: 'local.md',
      markdown: '## Methods\nAlpha\n#### Details\nBeta\n## Results\nGamma', language: 'en' as const,
    };
    const chunks = chunkMarkdownDocument(request);
    expect(chunks.map((chunk) => chunk.sectionPath)).toEqual([
      ['Methods'],
      ['Methods', 'Details'],
      ['Results'],
    ]);
    for (const chunk of chunks) {
      const extraction = toExtractionChunk('c1', chunk, request);
      expect(Object.hasOwn(extraction.metadata, 'doi')).toBe(false);
      expect(Object.hasOwn(extraction.metadata, 'sourceDb')).toBe(false);
      expect(Object.hasOwn(extraction.metadata, 'sourceType')).toBe(false);
      const passage = {
        passageId: `passage:${chunk.chunkId}`, corpusId: 'c1', text: chunk.text,
        normalizedText: chunk.normalizedText, metadata: extraction.metadata,
        factIds: [], entityMentions: [], qualityFlags: [],
        createdAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-25T00:00:00.000Z',
      };
      expect(validateDomainObject('passage', passage)).toEqual({ valid: true, errors: [] });
      expect(validateDomainObject('passage', JSON.parse(JSON.stringify(passage)))).toEqual({ valid: true, errors: [] });
    }
  });

  it('keeps a short no-heading English document as one exact normalized chunk', () => {
    const request = {
      corpusId: 'c1',
      documentId: 'doc-en-short',
      title: 'Short English',
      sourceUrl: 'https://example.com/short',
      language: 'en' as const,
      markdown: '  Short English paragraph.  ',
    };

    expect(chunkMarkdownDocument(request)).toEqual([{
      chunkId: 'doc-en-short:0',
      text: 'Short English paragraph.',
      normalizedText: 'short english paragraph.',
      sectionPath: [],
      chunkIndex: 0,
      offsetStart: 0,
      offsetEnd: 'Short English paragraph.'.length,
      features: {
        hasCodeBlock: false,
        hasTable: false,
        hasReferences: false,
      },
    }]);
  });

  it('returns empty Ginza results without invoking the sidecar and delegates English', async () => {
    const sidecar = { chunkSentences: vi.fn(), extractEntitiesJa: vi.fn() };
    const emptyRequest = {
      corpusId: 'c1',
      documentId: 'doc-empty-ginza',
      title: 'Empty',
      sourceUrl: 'https://example.com/empty',
      language: 'ja' as const,
      markdown: '   ',
    };
    await expect(chunkMarkdownDocumentWithGinza(emptyRequest, sidecar)).resolves.toEqual([]);
    expect(sidecar.chunkSentences).not.toHaveBeenCalled();

    const englishRequest = {
      ...emptyRequest,
      documentId: 'doc-en-ginza',
      language: 'en' as const,
      markdown: 'English text without headings.',
    };
    await expect(chunkMarkdownDocumentWithGinza(englishRequest, sidecar)).resolves.toEqual(
      chunkMarkdownDocument(englishRequest),
    );
    expect(sidecar.chunkSentences).not.toHaveBeenCalled();
  });

  it('bypasses Ginza for a short no-heading Japanese section with exact metadata', async () => {
    const sidecar = { chunkSentences: vi.fn(), extractEntitiesJa: vi.fn() };
    const request = {
      corpusId: 'c1',
      documentId: 'doc-ja-short-ginza',
      title: '短い日本語',
      sourceUrl: 'https://example.com/ja-short',
      language: 'ja' as const,
      markdown: '短い日本語。',
    };

    await expect(chunkMarkdownDocumentWithGinza(request, sidecar)).resolves.toEqual([{
      chunkId: 'doc-ja-short-ginza:0',
      text: '短い日本語。',
      normalizedText: '短い日本語。',
      sectionPath: [],
      chunkIndex: 0,
      offsetStart: 0,
      offsetEnd: request.markdown.length,
      features: {
        hasCodeBlock: false,
        hasTable: false,
        hasReferences: false,
      },
    }]);
    expect(sidecar.chunkSentences).not.toHaveBeenCalled();
  });

  it('keeps jumped Japanese heading levels dense on the Ginza path', async () => {
    const sidecar = { chunkSentences: vi.fn(), extractEntitiesJa: vi.fn() };
    const request = {
      corpusId: 'c1', documentId: 'doc-ja-jump', title: '日本語',
      sourceUrl: 'local.md', language: 'ja' as const,
      markdown: '## 方法\n短い本文。\n#### 詳細\n別の短い本文。\n## 結果\n結果本文。',
    };
    const chunks = await chunkMarkdownDocumentWithGinza(request, sidecar);
    expect(chunks.map((chunk) => chunk.sectionPath)).toEqual([
      ['方法'],
      ['方法', '詳細'],
      ['結果'],
    ]);
    expect(sidecar.chunkSentences).not.toHaveBeenCalled();
  });

  it('uses Ginza chunks for oversized Japanese sections and falls back on sidecar errors', async () => {
    const request = { corpusId: 'c1', documentId: 'doc-ja', title: '日本語', sourceUrl: 'https://example.com', language: 'ja' as const, markdown: '# 見出し\n' + 'これは長い文章です。'.repeat(300) };
    const sidecar = { chunkSentences: vi.fn().mockResolvedValue([{ text: '第一文。', sentenceCount: 1, estimatedTokens: 2 }, { text: '第二文。', sentenceCount: 1, estimatedTokens: 2 }]), extractEntitiesJa: vi.fn() };
    const chunks = await chunkMarkdownDocumentWithGinza(request, sidecar);
    expect(chunks.map((x) => x.text)).toEqual(['第一文。', '第二文。']);
    expect(chunks.every((item) => item.sectionPath[0] === '見出し')).toBe(true);
    expect(sidecar.chunkSentences).toHaveBeenCalledWith(request.markdown.trim(), 500);
    const fallback = await chunkMarkdownDocumentWithGinza(request, { ...sidecar, chunkSentences: vi.fn().mockRejectedValue(new Error('sidecar unavailable')) });
    expect(fallback).toHaveLength(1);
    expect(fallback[0]).toMatchObject({
      text: request.markdown.trim(),
      sectionPath: ['見出し'],
      offsetStart: 0,
      offsetEnd: request.markdown.length,
    });
  });

  it('commits document metadata and stops before downstream stages for empty input', async () => {
    const db = openDatabase(':memory:');
    runMigrations(db);
    db.prepare('INSERT INTO corpora (corpus_id, name, description) VALUES (?, ?, ?)')
      .run('c1', 'Corpus 1', 'pipeline boundary');
    const graphStore = { upsertNodes: vi.fn(), upsertEdges: vi.fn() };
    const vectorIndex = { upsert: vi.fn() };
    const indexingMemory = {
      getSchemasByIds: vi.fn(),
      getActiveFacts: vi.fn(),
      preflightMutation: vi.fn(),
      activateFactsBySchemaIds: vi.fn(),
      upsertDelta: vi.fn(),
    };
    const pipeline = new FullDocumentIndexingPipeline({
      db,
      graphStore: graphStore as never,
      vectorIndex: vectorIndex as never,
      indexingMemory: indexingMemory as never,
      llmProvider: provider('{}'),
      embeddingProvider: { embed: vi.fn(), healthCheck: vi.fn() } as never,
      nlpExtractor: { extract: vi.fn(), healthCheck: vi.fn() } as never,
    });

    await expect(pipeline.processDocument('c1', {
      documentId: 'doc-empty',
      markdown: '',
      title: 'Empty',
      sourceUrl: 'https://example.com/empty',
    })).resolves.toEqual({
      processedDocumentId: 'doc-empty',
      addedNodes: 0,
      addedEdges: 0,
      conflicts: 0,
    });
    expect(db.prepare('SELECT document_id, corpus_id FROM documents').all()).toEqual([
      { document_id: 'doc-empty', corpus_id: 'c1' },
    ]);
    expect(graphStore.upsertNodes).not.toHaveBeenCalled();
    expect(vectorIndex.upsert).not.toHaveBeenCalled();
    expect(indexingMemory.getSchemasByIds).not.toHaveBeenCalled();
    expect(indexingMemory.upsertDelta).not.toHaveBeenCalled();
    db.close();
  });

  it('indexes through one bounded schema/fact read and writes only the document delta', async () => {
    const db = openDatabase(':memory:');
    runMigrations(db);
    db.prepare('INSERT INTO corpora (corpus_id, name, description) VALUES (?, ?, ?)')
      .run('c1', 'Corpus 1', 'bounded indexing');
    const oldTimestamp = '2026-01-01T00:00:00.000Z';
    const storedSchema = {
      schemaId: 'schema:person::authors::paper',
      corpusId: 'c1',
      headType: 'person',
      relation: 'authors',
      tailType: 'paper',
      canonicalKey: 'person::authors::paper',
      aliases: [],
      frequency: 1,
      state: 'pending' as const,
      stabilizationThreshold: 2,
      factIds: ['old-fact'],
      sourceDocumentIds: ['old-doc'],
      version: 1,
      createdAt: oldTimestamp,
      updatedAt: oldTimestamp,
    };
    const indexingMemory = {
      getSchemasByIds: vi.fn().mockResolvedValue([storedSchema]),
      getActiveFacts: vi.fn().mockResolvedValue([]),
      preflightMutation: vi.fn(),
      activateFactsBySchemaIds: vi.fn().mockResolvedValue(1),
      upsertDelta: vi.fn().mockResolvedValue(undefined),
    };
    const graphStore = {
      upsertNodes: vi.fn().mockResolvedValue(undefined),
      upsertEdges: vi.fn().mockResolvedValue(undefined),
    };
    const vectorIndex = { upsert: vi.fn().mockResolvedValue(undefined) };
    const embeddingProvider = {
      embed: vi.fn().mockImplementation(async ({ texts }: { texts: readonly string[] }) => ({
        vectors: texts.map(() => [1]),
        model: 'test',
        cached: false,
      })),
      healthCheck: vi.fn(),
    };
    const nlpExtractor = {
      extract: vi.fn().mockResolvedValue({ language: 'en', entities: [], nounPhrases: [] }),
      healthCheck: vi.fn(),
    };
    const pipeline = new FullDocumentIndexingPipeline({
      db,
      graphStore: graphStore as never,
      vectorIndex: vectorIndex as never,
      indexingMemory: indexingMemory as never,
      llmProvider: provider(JSON.stringify({
        entities: [{ name: 'Alice', type: 'Person' }, { name: 'Paper A', type: 'Paper' }],
        relations: [{
          head: 'Alice',
          headType: 'Person',
          relation: 'authors',
          tail: 'Paper A',
          tailType: 'Paper',
          confidence: 0.9,
        }],
      })),
      embeddingProvider: embeddingProvider as never,
      nlpExtractor: nlpExtractor as never,
      enableDictionaryIndexing: false,
    });

    await expect(pipeline.processDocument('c1', {
      documentId: 'doc-1',
      markdown: 'Alice authors Paper A.',
      title: 'Paper',
      sourceUrl: 'https://example.com/paper',
      language: 'en',
    })).resolves.toMatchObject({ processedDocumentId: 'doc-1', conflicts: 0 });

    expect(indexingMemory.getSchemasByIds).toHaveBeenCalledOnce();
    expect(indexingMemory.getSchemasByIds).toHaveBeenCalledWith({
      corpusId: 'c1',
      schemaIds: ['schema:person::authors::paper'],
    });
    expect(indexingMemory.getActiveFacts).toHaveBeenCalledOnce();
    expect(indexingMemory.getActiveFacts).toHaveBeenCalledWith({ corpusId: 'c1', limit: 100 });
    expect(indexingMemory.preflightMutation).toHaveBeenCalledOnce();
    expect(indexingMemory.activateFactsBySchemaIds).toHaveBeenCalledWith(expect.objectContaining({
      corpusId: 'c1',
      schemaIds: ['schema:person::authors::paper'],
    }));
    expect(indexingMemory.upsertDelta).toHaveBeenCalledOnce();
    expect(indexingMemory.upsertDelta).toHaveBeenCalledWith(expect.objectContaining({
      corpusId: 'c1',
      schemas: [expect.objectContaining({ frequency: 2, state: 'stable' })],
      facts: [expect.objectContaining({ state: 'active' })],
      passages: [expect.objectContaining({ corpusId: 'c1' })],
    }));
    expect(indexingMemory.upsertDelta.mock.invocationCallOrder[0]!)
      .toBeLessThan(indexingMemory.activateFactsBySchemaIds.mock.invocationCallOrder[0]!);
    db.close();
  });

  it.each([
    {
      name: 'newly stable schema',
      harnessOptions: { storedFrequency: 1, storedState: 'pending' as const },
      expectedTrace: ['preflight', 'memory', 'activation', 'graph_nodes', 'graph_edges', 'vector'],
    },
    {
      name: 'already stable schema',
      harnessOptions: { storedFrequency: 2, storedState: 'stable' as const },
      expectedTrace: ['preflight', 'memory', 'graph_nodes', 'graph_edges', 'vector'],
    },
  ])('does not observe Stage V inputs and preserves the core mutation order for $name', async ({
    harnessOptions,
    expectedTrace,
  }) => {
    const harness = mutationBoundaryHarness(
      provider(extractionResponse()),
      'authors',
      { ...harnessOptions, trapStageVAccess: true },
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await expect(harness.run()).resolves.toMatchObject({
        processedDocumentId: 'doc-boundary',
        addedNodes: expect.any(Number),
        addedEdges: expect.any(Number),
        conflicts: 0,
      });

      expect(Object.getOwnPropertyDescriptor(harness.pipelineOptions, 'dictionary')).toBeUndefined();
      expect(Object.getOwnPropertyDescriptor(harness.pipelineOptions, 'dictionaryFactory')).toBeUndefined();
      expect(harness.dictionaryRead).not.toHaveBeenCalled();
      expect(harness.dictionaryFactoryRead).not.toHaveBeenCalled();
      expect(harness.mutationTrace).toEqual(expectedTrace);
      expect(harness.graphStore.upsertNodes).toHaveBeenCalledOnce();
      expect(harness.graphStore.upsertEdges).toHaveBeenCalledOnce();
      expect(harness.vectorIndex.upsert).toHaveBeenCalledOnce();
      expect(log.mock.calls.flat().some((value) => String(value).includes('Stage V:'))).toBe(false);

      for (const table of [
        'term_dictionary',
        'thesaurus_relations',
        'dictionary_candidates',
        'lexicon_evidence',
      ]) {
        expect(harness.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
      }
    } finally {
      log.mockRestore();
      harness.db.close();
    }
  });

  it('keeps deterministic mutation preflight failures outside the fatal boundary', async () => {
    const harness = mutationBoundaryHarness();
    harness.indexingMemory.preflightMutation.mockImplementation(() => {
      throw new Error('delta preflight rejected');
    });

    await expect(harness.run()).rejects.toThrow('delta preflight rejected');

    expect(harness.embeddingProvider.embed).not.toHaveBeenCalled();
    expect(harness.indexingMemory.upsertDelta).not.toHaveBeenCalled();
    expect(harness.indexingMemory.activateFactsBySchemaIds).not.toHaveBeenCalled();
    expect(harness.graphStore.upsertNodes).not.toHaveBeenCalled();
    expect(harness.vectorIndex.upsert).not.toHaveBeenCalled();
    harness.db.close();
  });

  it('wires one folded fact and its links while retaining schema candidate pressure', async () => {
    const harness = mutationBoundaryHarness(provider([
      extractionResponse('authors papers'),
      extractionResponse('authors  papers'),
    ]), 'authors papers');

    await expect(harness.run([
      '# First',
      'Alice authors Paper A.',
      '',
      '# Second',
      'Alice authors Paper A.',
    ].join('\n'))).resolves.toMatchObject({ processedDocumentId: 'doc-boundary' });

    const delta = harness.indexingMemory.upsertDelta.mock.calls[0]![0];
    expect(delta.facts).toHaveLength(1);
    expect(delta.facts[0].relation).toBe('authors papers');
    expect(delta.facts[0].passageIds).toHaveLength(2);
    expect(delta.schemas).toEqual([
      expect.objectContaining({
        frequency: 3,
        factIds: [delta.facts[0].factId],
      }),
    ]);
    expect(delta.passages).toHaveLength(2);
    expect(delta.passages.map((passage: { factIds: readonly string[] }) => passage.factIds))
      .toEqual([[delta.facts[0].factId], [delta.facts[0].factId]]);
    harness.db.close();
  });

  it('finishes embedding work before the first persistence mutation', async () => {
    const harness = mutationBoundaryHarness();
    harness.embeddingProvider.embed.mockRejectedValue(new Error('embedding unavailable'));

    await expect(harness.run()).rejects.toThrow('embedding unavailable');

    expect(harness.indexingMemory.preflightMutation).toHaveBeenCalledOnce();
    expect(harness.indexingMemory.upsertDelta).not.toHaveBeenCalled();
    expect(harness.indexingMemory.activateFactsBySchemaIds).not.toHaveBeenCalled();
    expect(harness.graphStore.upsertNodes).not.toHaveBeenCalled();
    expect(harness.vectorIndex.upsert).not.toHaveBeenCalled();
    harness.db.close();
  });

  it.each([
    ['delta admission', (harness: ReturnType<typeof mutationBoundaryHarness>) => {
      harness.indexingMemory.upsertDelta.mockRejectedValue(new Error('delta WAL failed'));
    }, 'upsertDelta'],
    ['activation', (harness: ReturnType<typeof mutationBoundaryHarness>) => {
      harness.indexingMemory.activateFactsBySchemaIds.mockRejectedValue(new Error('activation WAL failed'));
    }, 'activateFactsBySchemaIds'],
    ['graph projection', (harness: ReturnType<typeof mutationBoundaryHarness>) => {
      harness.graphStore.upsertNodes.mockRejectedValue(new Error('graph WAL failed'));
    }, 'upsertNodes'],
    ['graph edge projection', (harness: ReturnType<typeof mutationBoundaryHarness>) => {
      harness.graphStore.upsertEdges.mockRejectedValue(new Error('graph edge WAL failed'));
    }, 'upsertEdges'],
    ['vector persistence', (harness: ReturnType<typeof mutationBoundaryHarness>) => {
      harness.vectorIndex.upsert.mockRejectedValue(new Error('vector WAL failed'));
    }, 'vectorUpsert'],
  ] as const)('marks a %s failure as post-admission fatal (%s)', async (_name, inject) => {
    const harness = mutationBoundaryHarness();
    inject(harness);

    await expect(harness.run()).rejects.toBeInstanceOf(DocumentMutationError);

    expect(harness.indexingMemory.preflightMutation).toHaveBeenCalledOnce();
    expect(harness.embeddingProvider.embed).toHaveBeenCalledOnce();
    harness.db.close();
  });

  it('preserves stable custom id order and writes downloaded vectors', async () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'batch-embed-test-'));
    const responses = [
      new Response(JSON.stringify({ id: 'file-1' }), { status: 200 }),
      new Response(JSON.stringify({ id: 'batch-1', status: 'completed', output_file_id: 'out-1', request_counts: { total: 2, completed: 2, failed: 0 } }), { status: 200 }),
      new Response(JSON.stringify({ id: 'batch-1', status: 'completed', output_file_id: 'out-1', request_counts: { total: 2, completed: 2, failed: 0 } }), { status: 200 }),
      new Response('{"custom_id":"emb-1","response":{"body":{"data":[{"embedding":[2]}]}}}\n{"custom_id":"emb-0","response":{"body":{"data":[{"embedding":[1]}]}}}\n'),
    ];
    const fetchMock = vi.fn().mockImplementation(async () => responses.shift()!);
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await new BatchEmbeddingProvider({ apiKey: 'key', model: 'embed', outputDir, pollIntervalMs: 0, maxWaitMs: 100 }).embed({ texts: ['first', 'second'] });
      expect(result.vectors).toEqual([[1], [2]]);
      expect(fetchMock).toHaveBeenCalledTimes(4);
    } finally {
      vi.unstubAllGlobals();
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('fails closed for missing key, empty input, failed batch, and missing result slots', async () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'batch-embed-test-'));
    try {
      await expect(new BatchEmbeddingProvider({ apiKey: ' ', model: 'embed', outputDir }).embed({ texts: ['x'] })).rejects.toThrow('API key');
      await expect(new BatchEmbeddingProvider({ apiKey: 'key', model: 'embed', outputDir }).embed({ texts: [] })).resolves.toMatchObject({ vectors: [], cached: true });
      const failedResponses = [
        new Response(JSON.stringify({ id: 'file-1' }), { status: 200 }),
        new Response(JSON.stringify({ id: 'batch-1', status: 'failed' }), { status: 200 }),
        new Response(JSON.stringify({ id: 'batch-1', status: 'failed' }), { status: 200 }),
      ];
      const failedFetch = vi.fn().mockImplementation(async () => failedResponses.shift()!);
      vi.stubGlobal('fetch', failedFetch);
      await expect(new BatchEmbeddingProvider({ apiKey: 'key', model: 'embed', outputDir, pollIntervalMs: 0, maxWaitMs: 100 }).embed({ texts: ['x'] })).rejects.toThrow('Batch batch-1 ended with status: failed');
      expect(failedFetch).toHaveBeenCalledTimes(3);
      expect(failedFetch.mock.calls.every(([url]) => !String(url).includes('/files/undefined/content'))).toBe(true);

      const incompleteResponses = [
        new Response(JSON.stringify({ id: 'file-2' }), { status: 200 }),
        new Response(JSON.stringify({ id: 'batch-2', status: 'completed', output_file_id: 'out-2' }), { status: 200 }),
        new Response(JSON.stringify({ id: 'batch-2', status: 'completed', output_file_id: 'out-2' }), { status: 200 }),
        new Response('{"custom_id":"emb-0","response":{"body":{"data":[{"embedding":[1]}]}}}\n'),
      ];
      vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => incompleteResponses.shift()!));
      await expect(new BatchEmbeddingProvider({ apiKey: 'key', model: 'embed', outputDir, pollIntervalMs: 0, maxWaitMs: 100 }).embed({ texts: ['x', 'y'] })).rejects.toThrow('Missing 1 embeddings');
    } finally {
      vi.unstubAllGlobals();
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
