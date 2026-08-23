import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LLMExtractionAgent } from '../../../../src/application/indexing/LLMExtractionAgent.js';
import { LLMConflictResolver } from '../../../../src/application/indexing/LLMConflictResolver.js';
import { FullDocumentIndexingPipeline } from '../../../../src/application/indexing/FullDocumentIndexingPipeline.js';
import { BatchEmbeddingProvider } from '../../../../src/infrastructure/embedding/BatchEmbeddingProvider.js';
import { openDatabase, runMigrations } from '../../../../src/infrastructure/storage/migrate.js';
import { chunkMarkdownDocument, chunkMarkdownDocumentWithGinza, fallbackParagraphSplit, toExtractionChunk } from '../../../../src/application/indexing/MarkdownChunker.js';
import type { ILLMProvider } from '../../../../src/domain/provider/llmProvider.js';
import type { ConflictResolutionRequest } from '../../../../src/domain/agent/conflictResolution.js';
import type { Fact } from '../../../../src/domain/memory/fact.js';
import type { Passage } from '../../../../src/domain/memory/passage.js';

const now = '2026-01-01T00:00:00.000Z';
const metadata = { documentId: 'doc-1', title: 'Doc', sourceUrl: 'https://example.com', language: 'en' as const, sectionPath: [], chunkId: 'chunk-1', chunkIndex: 0, offsetStart: 0, offsetEnd: 20 };
const chunk = { corpusId: 'c1', documentId: 'doc-1', chunkId: 'chunk-1', text: 'TP53 regulates apoptosis.', normalizedText: 'tp53 regulates apoptosis.', language: 'en' as const, metadata };

function provider(text: string): ILLMProvider {
  return { generate: vi.fn().mockResolvedValue({ text, model: 'test', usage: { inputTokens: 1, outputTokens: 1 } }), healthCheck: vi.fn() };
}

function fact(id: string, tailEntity: string): Fact {
  return { factId: id, corpusId: 'c1', schemaId: 's1', headEntity: 'TP53', headType: 'Gene', relation: 'regulates', tailEntity, tailType: 'Process', state: 'active', passageIds: ['p1'], sourceDocumentIds: ['doc-1'], confidence: 0.9, createdAt: now, updatedAt: now };
}

function passage(): Passage {
  return { passageId: 'p1', corpusId: 'c1', text: 'TP53 regulates apoptosis.', normalizedText: 'tp53 regulates apoptosis.', metadata, factIds: [], entityMentions: [], qualityFlags: [], createdAt: now, updatedAt: now };
}

function conflictRequest(): ConflictResolutionRequest {
  return { conflictSet: { conflictType: 'mutual_exclusion', newFact: fact('new', 'necrosis'), conflictingFacts: [fact('old', 'apoptosis')] }, evidencePassages: [passage()] };
}

describe('indexing and provider behavioral boundaries', () => {
  it('extracts valid JSON, strips fences, drops malformed entries, and preserves metadata', async () => {
    const llm = provider('```json\n{"entities":[{"name":"TP53","type":"Gene"},{"name":3}],"relations":[{"head":"TP53","headType":"Gene","relation":"regulates","tail":"apoptosis","tailType":"Process","confidence":0.9},{"head":"bad"}]}\n```');
    const result = await new LLMExtractionAgent(llm).extract(chunk);
    expect(result.rawEntities).toEqual(['TP53']);
    expect(result.candidateFacts).toHaveLength(1);
    expect(result.candidateSchemas[0]?.canonicalKey).toBe('gene::regulates::process');
    expect(result.sourcePassage.passageId).toBe('passage:chunk-1');
    expect(llm.generate).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 2000 }));
  });

  it('fails malformed or provider-rejected extraction conservatively', async () => {
    const malformed = await new LLMExtractionAgent(provider('not-json')).extract({ ...chunk, normalizedText: '日本語の文章です。' });
    expect(malformed.candidateFacts).toEqual([]);
    const rejected: ILLMProvider = { generate: vi.fn().mockRejectedValue(new Error('cancelled')), healthCheck: vi.fn() };
    await expect(new LLMExtractionAgent(rejected).extract(chunk)).rejects.toThrow('cancelled');
  });

  it.each([
    ['keep_new', 'resolved_keep_new', ['new'], ['old']],
    ['keep_existing', 'resolved_keep_existing', ['old'], ['new']],
    ['keep_both', 'merged', ['new', 'old'], []],
    ['discard_both', 'resolved_keep_existing', [], ['new', 'old']],
  ] as const)('maps conflict decision %s to durable ids/state', async (decision, state, kept, inactive) => {
    const resolver = new LLMConflictResolver(provider(JSON.stringify({ decision, confidence: 0.8, rationale: 'evidence' })));
    const result = await resolver.resolve(conflictRequest());
    expect(result.state).toBe(state);
    expect(result.keptFactIds).toEqual(kept);
    expect(result.inactivatedFactIds).toEqual(inactive);
    expect(result.evidence[0]?.supportsFactIds).toEqual(kept);
  });

  it('uses conservative unresolved fallback for malformed and failed conflict responses', async () => {
    const malformed = await new LLMConflictResolver(provider('no json')).resolve(conflictRequest());
    expect(malformed.state).toBe('merged');
    expect(malformed.confidence).toBe(0.3);
    const rejected: ILLMProvider = { generate: vi.fn().mockRejectedValue(new Error('provider down')), healthCheck: vi.fn() };
    const result = await new LLMConflictResolver(rejected).resolve(conflictRequest());
    expect(result.state).toBe('unresolved');
    expect(result.keptFactIds).toEqual(['new', 'old']);
    expect(result.evidence).toEqual([]);
  });

  it('chunks empty, heading, feature-rich, and oversized fallback markdown with stable metadata', () => {
    const base = { corpusId: 'c1', documentId: 'doc-1', title: 'Doc', sourceUrl: 'https://example.com', language: 'en' as const, markdown: '' };
    expect(chunkMarkdownDocument(base)).toEqual([]);
    const chunks = chunkMarkdownDocument({ ...base, markdown: '# Intro\nA table | value |\n\n## References\n[1] citation' });
    expect(chunks.map((x) => x.sectionPath)).toEqual([['Intro'], ['Intro', 'References']]);
    expect(chunks[1]?.features.hasReferences).toBe(true);
    expect(chunks[0]?.features.hasTable).toBe(true);
    const parts = fallbackParagraphSplit('one\n\ntwo\n\nthree', 1, 1);
    expect(parts.length).toBeGreaterThan(1);
    const extraction = toExtractionChunk('c1', chunks[0]!, { ...base, markdown: chunks[0]!.text });
    expect(extraction.metadata.chunkId).toBe(chunks[0]!.chunkId);
  });

  it('uses Ginza chunks for oversized Japanese sections and falls back on sidecar errors', async () => {
    const request = { corpusId: 'c1', documentId: 'doc-ja', title: '日本語', sourceUrl: 'https://example.com', language: 'ja' as const, markdown: '# 見出し\n' + 'これは長い文章です。'.repeat(300) };
    const sidecar = { chunkSentences: vi.fn().mockResolvedValue([{ text: '第一文。', sentenceCount: 1, estimatedTokens: 2 }, { text: '第二文。', sentenceCount: 1, estimatedTokens: 2 }]), extractEntitiesJa: vi.fn() };
    const chunks = await chunkMarkdownDocumentWithGinza(request, sidecar);
    expect(chunks.map((x) => x.text)).toEqual(['第一文。', '第二文。']);
    const fallback = await chunkMarkdownDocumentWithGinza(request, { ...sidecar, chunkSentences: vi.fn().mockRejectedValue(new Error('sidecar unavailable')) });
    expect(fallback.length).toBeGreaterThan(0);
  });

  it('commits document metadata and stops before downstream stages for empty input', async () => {
    const db = openDatabase(':memory:');
    runMigrations(db);
    db.prepare('INSERT INTO corpora (corpus_id, name, description) VALUES (?, ?, ?)')
      .run('c1', 'Corpus 1', 'pipeline boundary');
    const graphStore = { upsertNodes: vi.fn(), upsertEdges: vi.fn() };
    const vectorIndex = { upsert: vi.fn() };
    const memoryStore = { load: vi.fn(), save: vi.fn() };
    const pipeline = new FullDocumentIndexingPipeline({
      db,
      graphStore: graphStore as never,
      vectorIndex: vectorIndex as never,
      memoryStore: memoryStore as never,
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
    expect(memoryStore.load).not.toHaveBeenCalled();
    db.close();
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
      vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => failedResponses.shift()!));
      await expect(new BatchEmbeddingProvider({ apiKey: 'key', model: 'embed', outputDir, pollIntervalMs: 0, maxWaitMs: 100 }).embed({ texts: ['x'] })).rejects.toThrow();

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
