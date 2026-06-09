import { describe, expect, it, vi } from 'vitest';
import type { CorpusManager, IndexingService } from '../../../src/application/index.js';
import { handleCreateCorpus, handleDeleteCorpus, handleListCorpora } from '../../../src/interface/mcp/handlers/corpusHandlers.js';
import { handleCancelJob, handleDeleteDocument, handleGetJobStatus, handleIndexDocuments } from '../../../src/interface/mcp/handlers/jobHandlers.js';
import { toToolError } from '../../../src/interface/mcp/errors.js';
import { SERVICE_TOKENS, type MemGraphRagRuntime } from '../../../src/interface/runtime/MemGraphRagRuntime.js';
import { createPartialMock } from '../../setup/testDoubles.js';

function createRuntime(overrides: { corpusManager?: Partial<CorpusManager>; indexingService?: Partial<IndexingService> } = {}): MemGraphRagRuntime {
  const corpusManager = createPartialMock<CorpusManager>('CorpusManager', {
    create: vi.fn().mockResolvedValue({ corpusId: 'corpus-1', name: 'Corpus', description: 'desc', documentCount: 0, nodeCount: 0, createdAt: '2026-01-01T00:00:00.000Z' }),
    delete: vi.fn().mockResolvedValue({ corpusId: 'corpus-1', cancelledJobs: 1, deletedDocuments: 2, deletedNodes: 3, deletedEdges: 4, deletedVectorRecords: 5 }),
    list: vi.fn().mockResolvedValue([{ corpusId: 'corpus-1', name: 'Corpus', description: 'desc', documentCount: 2, nodeCount: 4, createdAt: '2026-01-01T00:00:00.000Z' }]),
    getJobStatus: vi.fn().mockResolvedValue({ jobId: 'job-1', status: 'completed', processedCount: 2, totalCount: 2, errorCount: 0, summary: { addedNodes: 1, addedEdges: 2, conflictCount: 0, skippedCount: 0 } }),
    cancelJob: vi.fn().mockResolvedValue({ jobId: 'job-1', status: 'cancelled' }),
    ...overrides.corpusManager,
  });
  const indexingService = createPartialMock<IndexingService>('IndexingService', {
    start: vi.fn().mockResolvedValue({ jobId: 'job-1' }),
    deleteDocument: vi.fn().mockResolvedValue({ corpusId: 'corpus-1', documentId: 'doc-1', deletedFacts: 2, deletedPassages: 3, deletedSchemas: 0, deletedGraphNodes: 1, deletedGraphEdges: 4, schemaFrequencyAdjusted: 2 }),
    ...overrides.indexingService,
  });

  return {
    start: async () => undefined,
    shutdown: async () => undefined,
    getService<T>(token: symbol): T {
      if (token === SERVICE_TOKENS.CORPUS_MANAGER) {
        return corpusManager as T;
      }
      if (token === SERVICE_TOKENS.INDEXING_SERVICE) {
        return indexingService as T;
      }
      throw new Error(`Unexpected token ${String(token)}`);
    },
  };
}

describe('TASK-MG-037: corpus/job MCP handlers', () => {
  it('creates a corpus', async () => {
    const result = await handleCreateCorpus({ name: 'Corpus', description: 'desc' }, createRuntime());
    expect(result.structuredContent).toEqual(expect.objectContaining({ corpus_id: 'corpus-1', name: 'Corpus' }));
  });

  it('validates create_corpus params', async () => {
    const result = await handleCreateCorpus({ description: 'desc' }, createRuntime()).catch((error) => error);
    expect(result.code).toBe('INVALID_PARAMS');
  });

  it('deletes a corpus', async () => {
    const result = await handleDeleteCorpus({ corpus_id: 'corpus-1' }, createRuntime());
    expect(result.structuredContent).toEqual(expect.objectContaining({ deleted_documents: 2 }));
  });

  it('lists corpora', async () => {
    const result = await handleListCorpora({}, createRuntime());
    expect(result.structuredContent).toEqual({
      corpora: [expect.objectContaining({ corpus_id: 'corpus-1', document_count: 2 })],
    });
  });

  it('indexes documents', async () => {
    const runtime = createRuntime();
    const result = await handleIndexDocuments({
      corpus_id: 'corpus-1',
      documents: [{ document_id: 'doc-1', markdown: '# Title', title: 'Doc', source_url: 'file:///doc.md', source_type: 'md' }],
    }, runtime);
    expect(result.structuredContent).toEqual({ job_id: 'job-1', status: 'pending' });
  });

  it('validates indexing params', async () => {
    const error = await handleIndexDocuments({ corpus_id: 'corpus-1', documents: [] }, createRuntime()).catch((value) => value);
    expect(error.code).toBe('INVALID_PARAMS');
  });

  it('gets job status', async () => {
    const result = await handleGetJobStatus({ job_id: 'job-1' }, createRuntime());
    expect(result.structuredContent).toEqual(expect.objectContaining({ status: 'completed', processed_count: 2 }));
  });

  it('cancels a job', async () => {
    const result = await handleCancelJob({ job_id: 'job-1' }, createRuntime());
    expect(result.structuredContent).toEqual({ job_id: 'job-1', status: 'cancelled' });
  });

  it('deletes a document', async () => {
    const result = await handleDeleteDocument({ corpus_id: 'corpus-1', document_id: 'doc-1' }, createRuntime());
    expect(result.structuredContent).toEqual(expect.objectContaining({ deleted_passages: 3, deleted_graph_edges: 4 }));
  });

  it('maps manager job lookup errors into tool-safe codes', async () => {
    const runtime = createRuntime({ corpusManager: { getJobStatus: vi.fn().mockRejectedValue(new Error('Job not found: job-404')) } });
    const error = await handleGetJobStatus({ job_id: 'job-404' }, runtime).catch((value) => value);
    expect(toToolError(error).code).toBe('JOB_NOT_FOUND');
  });

  it('passes through delete document validation errors', async () => {
    const error = await handleDeleteDocument({ corpus_id: 'corpus-1' }, createRuntime()).catch((value) => value);
    expect(error.code).toBe('INVALID_PARAMS');
  });
});
