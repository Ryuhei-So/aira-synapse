import { describe, expect, it, vi } from 'vitest';
import type { CorpusManager, IndexingService } from '../../../src/application/index.js';
import { handleCreateCorpus, handleListCorpora } from '../../../src/interface/mcp/handlers/corpusHandlers.js';
import { handleCancelJob, handleGetJobStatus, handleIndexDocuments } from '../../../src/interface/mcp/handlers/jobHandlers.js';
import { toToolError } from '../../../src/interface/mcp/errors.js';
import { SERVICE_TOKENS, type MemGraphRagRuntime } from '../../../src/interface/runtime/MemGraphRagRuntime.js';

type Corpus = { corpusId: string; name: string; description?: string; createdAt: string; documentCount: number; nodeCount: number };
type Job = { jobId: string; corpusId: string; status: 'pending' | 'running' | 'completed' | 'cancelled'; processedCount: number; totalCount: number; errorCount: number; errors: readonly unknown[] };

function createRuntime() {
  const corpora: Corpus[] = [];
  const jobs = new Map<string, Job>();

  const corpusManager: CorpusManager = {
    create: vi.fn(async (name: string, description?: string) => {
      const corpus: Corpus = { corpusId: `corpus-${corpora.length + 1}`, name, description, createdAt: '2026-01-01T00:00:00.000Z', documentCount: 0, nodeCount: 0 };
      corpora.push(corpus);
      return corpus;
    }),
    list: vi.fn(async () => corpora),
    delete: vi.fn(async () => ({ corpusId: 'corpus-1', cancelledJobs: 0, deletedDocuments: 0, deletedNodes: 0, deletedEdges: 0, deletedVectorRecords: 0 })),
    getStats: vi.fn(async (corpusId: string) => ({ memory: { corpusId, totalSchemas: 0, stableSchemas: 0, totalFacts: 0, activeFacts: 0, inactiveFacts: 0, totalPassages: 0, linkedFacts: 0, detectedConflicts: 0, resolvedConflicts: 0, connectedComponents: 0 }, graph: { nodeCount: 0, edgeCount: 0, connectedComponents: 0 }, dictionaries: { totalTerms: 0, domains: {}, boostAppliedRate: 0, discoveredTermCount: 0 }, documents: [] })),
    getJobStatus: vi.fn(async (jobId: string) => jobs.get(jobId) ?? (() => { throw new Error('Job not found'); })()),
    cancelJob: vi.fn(async (jobId: string) => {
      const job = jobs.get(jobId);
      if (!job) throw new Error('Job not found');
      job.status = 'cancelled';
      return { jobId, status: 'cancelled' as const };
    }),
    analyzeConflicts: vi.fn(async () => ({ conflicts: [], distribution: {} })),
    exportGraph: vi.fn(async () => ({ format: 'json' as const, data: '{}', offset: 0, limit: 100, hasMore: false, nextOffset: undefined, totalNodes: 0 })),
  };

  const indexingService: IndexingService = {
    start: vi.fn(async ({ corpusId, documents }) => {
      const jobId = `job-${jobs.size + 1}`;
      jobs.set(jobId, { jobId, corpusId, status: 'pending', processedCount: 0, totalCount: documents.length, errorCount: 0, errors: [] });
      return { jobId };
    }),
    resume: vi.fn(async (jobId: string) => {
      const job = jobs.get(jobId);
      if (job) {
        job.status = 'completed';
        job.processedCount = job.totalCount;
      }
    }),
    cancel: vi.fn(async (jobId: string) => {
      const job = jobs.get(jobId);
      if (job) job.status = 'cancelled';
    }),
    deleteDocument: vi.fn(async (corpusId: string, documentId: string) => ({ corpusId, documentId, deletedFacts: 0, deletedPassages: 0, deletedSchemas: 0, deletedGraphNodes: 0, deletedGraphEdges: 0, schemaFrequencyAdjusted: false })),
  };

  const runtime: MemGraphRagRuntime = {
    start: async () => undefined,
    shutdown: async () => undefined,
    getService<T>(token: symbol): T {
      if (token === SERVICE_TOKENS.CORPUS_MANAGER) return corpusManager as T;
      if (token === SERVICE_TOKENS.INDEXING_SERVICE) return indexingService as T;
      throw new Error(`Unexpected token ${String(token)}`);
    },
  };

  return { runtime, corpusManager, indexingService, jobs };
}

describe('TASK-MG-055: MCP corpus/job integration', () => {
  it('creates a corpus and lists it through MCP handlers', async () => {
    const { runtime } = createRuntime();

    const created = await handleCreateCorpus({ name: 'Research Corpus', description: 'papers' }, runtime);
    const listed = await handleListCorpora({}, runtime);

    expect(created.structuredContent).toEqual(expect.objectContaining({ name: 'Research Corpus' }));
    expect(listed.structuredContent).toEqual(expect.objectContaining({ corpora: [expect.objectContaining({ name: 'Research Corpus' })] }));
  });

  it('queues indexing jobs and reports pending status', async () => {
    const { runtime } = createRuntime();
    const indexResult = await handleIndexDocuments({ corpus_id: 'corpus-1', documents: [{ document_id: 'doc-1', markdown: '# Title', title: 'Doc 1', source_url: 'https://example.com/doc-1' }] }, runtime);
    const jobId = (indexResult.structuredContent as { job_id: string }).job_id;
    const status = await handleGetJobStatus({ job_id: jobId }, runtime);

    expect(status.structuredContent).toEqual(expect.objectContaining({ job_id: jobId, status: 'pending', total_count: 1 }));
  });

  it('cancels queued jobs via MCP handlers', async () => {
    const { runtime } = createRuntime();
    const indexResult = await handleIndexDocuments({ corpus_id: 'corpus-1', documents: [{ document_id: 'doc-1', markdown: '# Title', title: 'Doc 1', source_url: 'https://example.com/doc-1' }] }, runtime);
    const jobId = (indexResult.structuredContent as { job_id: string }).job_id;

    const cancelled = await handleCancelJob({ job_id: jobId }, runtime);
    const status = await handleGetJobStatus({ job_id: jobId }, runtime);

    expect(cancelled.structuredContent).toEqual({ job_id: jobId, status: 'cancelled' });
    expect(status.structuredContent).toEqual(expect.objectContaining({ status: 'cancelled' }));
  });

  it('surfaces job-not-found errors for unknown ids', async () => {
    const { runtime } = createRuntime();
    const error = await handleGetJobStatus({ job_id: 'missing-job' }, runtime).catch((value) => value);
    expect(toToolError(error).code).toBe('JOB_NOT_FOUND');
  });
});
