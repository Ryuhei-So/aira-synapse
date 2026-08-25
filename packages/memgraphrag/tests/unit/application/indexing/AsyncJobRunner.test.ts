import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { IMemoryStore } from '../../../../src/domain/storage/index.js';
import { runMigrations } from '../../../../src/infrastructure/storage/migrate.js';
import { createNotImplementedStub } from '../../../setup/testDoubles.js';
import {
  AsyncJobRunner,
  DocumentMutationError,
  type StorageWriteBatch,
} from '../../../../src/application/indexing/AsyncJobRunner.js';
import { DefaultIndexingService } from '../../../../src/application/indexing/IndexingService.js';
import type { IndexDocumentsCommand } from '../../../../src/application/indexing/IndexingService.js';
import type { DeleteDocumentResult } from '../../../../src/application/indexing/DeleteDocumentService.js';

function command(): IndexDocumentsCommand {
  return {
    corpusId: 'corpus-1',
    documents: [{
      documentId: 'doc-1',
      markdown: '# Intro\nContent',
      title: 'Doc',
      sourceUrl: 'https://example.com/doc',
      sourceType: 'md',
      language: 'en',
    }],
  };
}

describe('TASK-MG-035: AsyncJobRunner and DefaultIndexingService', () => {
  let db: Database.Database;
  let memoryStore: IMemoryStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.prepare(`INSERT INTO corpora (corpus_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run('corpus-1', 'Corpus', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    memoryStore = {
      ...createNotImplementedStub<IMemoryStore>('IMemoryStore'),
      loadCheckpoint: vi.fn<IMemoryStore['loadCheckpoint']>().mockResolvedValue(null),
      saveCheckpoint: vi.fn<IMemoryStore['saveCheckpoint']>().mockResolvedValue(),
    } satisfies IMemoryStore;
  });

  it('registers, enqueues, and executes a job document pipeline', async () => {
    const pipeline = { processDocument: vi.fn().mockResolvedValue({ processedDocumentId: 'doc-1', addedNodes: 3, addedEdges: 2, conflicts: 0 }) };
    const runner = new AsyncJobRunner(db, memoryStore, pipeline);
    runner.registerJob('job-1', command());
    await runner.enqueue('job-1');
    await runner.execute('job-1');

    const row = db.prepare('SELECT status, processed, total FROM jobs WHERE job_id = ?').get('job-1') as { status: string; processed: number; total: number };
    expect(pipeline.processDocument).toHaveBeenCalledTimes(1);
    expect(memoryStore.saveCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-1', processedDocumentIds: ['doc-1'] }));
    expect(row).toEqual({ status: 'completed', processed: 1, total: 1 });
  });

  it('commits the backend before the durable completed status', async () => {
    const pipeline = { processDocument: vi.fn().mockResolvedValue({ processedDocumentId: 'doc-1', addedNodes: 3, addedEdges: 2, conflicts: 0 }) };
    const statusesAtCommit: string[] = [];
    const storageBatch = {
      begin: vi.fn<() => Promise<void>>().mockResolvedValue(),
      commit: vi.fn<() => Promise<void>>().mockImplementation(async () => {
        const row = db.prepare('SELECT status FROM jobs WHERE job_id = ?').get('job-1') as { status: string };
        statusesAtCommit.push(row.status);
      }),
      abandon: vi.fn<() => Promise<void>>().mockResolvedValue(),
    } satisfies StorageWriteBatch;
    const runner = new AsyncJobRunner(db, memoryStore, pipeline, storageBatch);
    runner.registerJob('job-1', command());
    await runner.enqueue('job-1');
    await runner.execute('job-1');

    expect(storageBatch.commit).toHaveBeenCalledTimes(1);
    expect(storageBatch.abandon).not.toHaveBeenCalled();
    expect(statusesAtCommit).toEqual(['running']);
    expect((db.prepare('SELECT status FROM jobs WHERE job_id = ?').get('job-1') as { status: string }).status).toBe('completed');
  });

  it('resumes from saved checkpoints by skipping processed documents', async () => {
    memoryStore = {
      ...memoryStore,
      loadCheckpoint: vi.fn<IMemoryStore['loadCheckpoint']>().mockResolvedValue({ jobId: 'job-1', corpusId: 'corpus-1', processedDocumentIds: ['doc-1'], updatedAt: '2026-01-01T00:00:00.000Z' }),
    } satisfies IMemoryStore;
    const pipeline = { processDocument: vi.fn().mockResolvedValue({ processedDocumentId: 'doc-1', addedNodes: 3, addedEdges: 2, conflicts: 0 }) };
    const runner = new AsyncJobRunner(db, memoryStore, pipeline);
    runner.registerJob('job-1', command());
    await runner.enqueue('job-1');
    await runner.execute('job-1');

    expect(pipeline.processDocument).not.toHaveBeenCalled();
    const row = db.prepare('SELECT status, processed FROM jobs WHERE job_id = ?').get('job-1') as { status: string; processed: number };
    expect(row).toEqual({ status: 'completed', processed: 1 });
  });

  it('cancels queued jobs and prevents execution', async () => {
    const pipeline = { processDocument: vi.fn().mockResolvedValue({ processedDocumentId: 'doc-1', addedNodes: 3, addedEdges: 2, conflicts: 0 }) };
    const runner = new AsyncJobRunner(db, memoryStore, pipeline);
    runner.registerJob('job-1', command());
    await runner.enqueue('job-1');
    await runner.cancel('job-1');
    await runner.execute('job-1');

    expect(pipeline.processDocument).not.toHaveBeenCalled();
    const row = db.prepare('SELECT status FROM jobs WHERE job_id = ?').get('job-1') as { status: string };
    expect(row.status).toBe('cancelled');
  });

  it('creates jobs through IndexingService.start and delegates resume/cancel', async () => {
    const pipeline = { processDocument: vi.fn().mockResolvedValue({ processedDocumentId: 'doc-1', addedNodes: 1, addedEdges: 1, conflicts: 0 }) };
    const runner = new AsyncJobRunner(db, memoryStore, pipeline);
    const deleteDocument = vi.fn<() => Promise<DeleteDocumentResult>>().mockResolvedValue({
      corpusId: 'corpus-1', documentId: 'doc-1', deletedFacts: 0, deletedPassages: 0, deletedSchemas: 0, deletedGraphNodes: 0, deletedGraphEdges: 0, schemaFrequencyAdjusted: 0,
    });
    const service = new DefaultIndexingService(db, runner, { deleteDocument });

    const started = await service.start(command());
    await service.resume(started.jobId);
    await service.cancel(started.jobId);
    await service.deleteDocument('corpus-1', 'doc-1');

    expect(started.jobId).toBeTruthy();
    expect(deleteDocument).toHaveBeenCalledWith('corpus-1', 'doc-1');
  });

  it('records inner document failures as completed structured job errors', async () => {
    const pipeline = { processDocument: vi.fn().mockRejectedValue(new Error('boom')) };
    const storageBatch = {
      begin: vi.fn<() => Promise<void>>().mockResolvedValue(),
      commit: vi.fn<() => Promise<void>>().mockResolvedValue(),
      abandon: vi.fn<() => Promise<void>>().mockResolvedValue(),
    };
    const runner = new AsyncJobRunner(db, memoryStore, pipeline, storageBatch);
    runner.registerJob('job-1', command());
    await runner.enqueue('job-1');
    await runner.execute('job-1');

    const row = db.prepare('SELECT status, processed, total, errors_json, summary FROM jobs WHERE job_id = ?').get('job-1') as { status: string; processed: number; total: number; errors_json: string; summary: string };
    expect(row.status).toBe('completed');
    expect(row.processed).toBe(0);
    expect(row.total).toBe(1);
    expect(JSON.parse(row.errors_json)).toEqual([{
      code: 'DOCUMENT_PROCESSING_FAILED',
      message: expect.stringContaining('boom'),
      documentId: 'doc-1',
    }]);
    expect(JSON.parse(row.summary)).toEqual(expect.objectContaining({
      skippedCount: 1,
      documentErrorCount: 1,
    }));
    expect(storageBatch.commit).toHaveBeenCalledTimes(1);
  });

  it('commits an earlier clean document when the next document fails before mutation', async () => {
    const twoDocuments: IndexDocumentsCommand = {
      ...command(),
      documents: [
        command().documents[0]!,
        { ...command().documents[0]!, documentId: 'doc-2', title: 'Doc 2' },
      ],
    };
    const pipeline = {
      processDocument: vi.fn().mockImplementation(async (_corpusId, document) => {
        if (document.documentId === 'doc-2') throw new Error('preflight rejected');
        return { processedDocumentId: 'doc-1', addedNodes: 1, addedEdges: 1, conflicts: 0 };
      }),
    };
    const storageBatch = {
      begin: vi.fn<() => Promise<void>>().mockResolvedValue(),
      commit: vi.fn<() => Promise<void>>().mockResolvedValue(),
      abandon: vi.fn<() => Promise<void>>().mockResolvedValue(),
    };
    const runner = new AsyncJobRunner(db, memoryStore, pipeline, storageBatch);
    runner.registerJob('job-1', twoDocuments);
    await runner.enqueue('job-1');

    await runner.execute('job-1');

    const row = db.prepare(
      'SELECT status, processed, errors_json FROM jobs WHERE job_id = ?',
    ).get('job-1') as { status: string; processed: number; errors_json: string };
    expect(row.status).toBe('completed');
    expect(row.processed).toBe(1);
    expect(JSON.parse(row.errors_json)).toEqual([
      expect.objectContaining({ documentId: 'doc-2', message: expect.stringContaining('preflight rejected') }),
    ]);
    expect(storageBatch.commit).toHaveBeenCalledOnce();
    expect(storageBatch.abandon).not.toHaveBeenCalled();
  });

  it('makes post-mutation document errors job-fatal and never commits the dirty batch', async () => {
    const pipeline = {
      processDocument: vi.fn().mockRejectedValue(new DocumentMutationError(new Error('native write failed'))),
    };
    const storageBatch = {
      begin: vi.fn<() => Promise<void>>().mockResolvedValue(),
      commit: vi.fn<() => Promise<void>>().mockResolvedValue(),
      abandon: vi.fn<() => Promise<void>>().mockResolvedValue(),
    };
    const runner = new AsyncJobRunner(db, memoryStore, pipeline, storageBatch);
    runner.registerJob('job-1', command());
    await runner.enqueue('job-1');
    await expect(runner.execute('job-1')).rejects.toBeInstanceOf(DocumentMutationError);

    const row = db.prepare('SELECT status, errors_json FROM jobs WHERE job_id = ?').get('job-1') as { status: string; errors_json: string };
    expect(row.status).toBe('failed');
    expect(JSON.parse(row.errors_json)).toEqual([{
      code: 'JOB_EXECUTION_FAILED',
      message: expect.stringContaining('document mutation failed after persistence began'),
    }]);
    expect(storageBatch.commit).not.toHaveBeenCalled();
    expect(storageBatch.abandon).toHaveBeenCalledOnce();
  });

  it('records outer storage failures as failed structured job errors', async () => {
    const pipeline = { processDocument: vi.fn().mockResolvedValue({ processedDocumentId: 'doc-1', addedNodes: 1, addedEdges: 1, conflicts: 0 }) };
    const storageBatch = {
      begin: vi.fn<() => Promise<void>>().mockRejectedValue(new Error('batch boom')),
      commit: vi.fn<() => Promise<void>>().mockResolvedValue(),
      abandon: vi.fn<() => Promise<void>>().mockResolvedValue(),
    };
    const runner = new AsyncJobRunner(db, memoryStore, pipeline, storageBatch);
    runner.registerJob('job-1', command());
    await runner.enqueue('job-1');
    await expect(runner.execute('job-1')).rejects.toThrow('batch boom');

    const row = db.prepare('SELECT status, errors_json FROM jobs WHERE job_id = ?').get('job-1') as { status: string; errors_json: string };
    expect(row.status).toBe('failed');
    expect(JSON.parse(row.errors_json)).toEqual([{
      code: 'JOB_EXECUTION_FAILED',
      message: expect.stringContaining('batch boom'),
    }]);
    expect(pipeline.processDocument).not.toHaveBeenCalled();
    expect(storageBatch.commit).not.toHaveBeenCalled();
    expect(storageBatch.abandon).toHaveBeenCalledOnce();
  });

  it('records checkpoint failures as failed structured job errors', async () => {
    memoryStore = {
      ...memoryStore,
      saveCheckpoint: vi.fn<IMemoryStore['saveCheckpoint']>().mockRejectedValue(new Error('checkpoint boom')),
    } satisfies IMemoryStore;
    const pipeline = { processDocument: vi.fn().mockResolvedValue({ processedDocumentId: 'doc-1', addedNodes: 1, addedEdges: 1, conflicts: 0 }) };
    const storageBatch = {
      begin: vi.fn<() => Promise<void>>().mockResolvedValue(),
      commit: vi.fn<() => Promise<void>>().mockResolvedValue(),
      abandon: vi.fn<() => Promise<void>>().mockResolvedValue(),
    };
    const runner = new AsyncJobRunner(db, memoryStore, pipeline, storageBatch);
    runner.registerJob('job-1', command());
    await runner.enqueue('job-1');
    await expect(runner.execute('job-1')).rejects.toThrow('checkpoint boom');

    const row = db.prepare('SELECT status, processed, errors_json FROM jobs WHERE job_id = ?').get('job-1') as { status: string; processed: number; errors_json: string };
    expect(row.status).toBe('failed');
    expect(row.processed).toBe(0);
    expect(JSON.parse(row.errors_json)).toEqual([{
      code: 'JOB_EXECUTION_FAILED',
      message: expect.stringContaining('checkpoint boom'),
    }]);
    expect(storageBatch.commit).not.toHaveBeenCalled();
    expect(storageBatch.abandon).toHaveBeenCalledOnce();
  });

  it('records final storage commit failures as failed without retrying commit', async () => {
    const pipeline = { processDocument: vi.fn().mockResolvedValue({ processedDocumentId: 'doc-1', addedNodes: 1, addedEdges: 1, conflicts: 0 }) };
    const storageBatch = {
      begin: vi.fn<() => Promise<void>>().mockResolvedValue(),
      commit: vi.fn<() => Promise<void>>().mockRejectedValue(new Error('final commit boom')),
      abandon: vi.fn<() => Promise<void>>().mockResolvedValue(),
    };
    const runner = new AsyncJobRunner(db, memoryStore, pipeline, storageBatch);
    runner.registerJob('job-1', command());
    await runner.enqueue('job-1');
    await expect(runner.execute('job-1')).rejects.toThrow('final commit boom');

    const row = db.prepare('SELECT status, processed, errors_json FROM jobs WHERE job_id = ?').get('job-1') as { status: string; processed: number; errors_json: string };
    expect(row.status).toBe('failed');
    expect(row.processed).toBe(1);
    expect(JSON.parse(row.errors_json)).toEqual([{
      code: 'JOB_EXECUTION_FAILED',
      message: expect.stringContaining('final commit boom'),
    }]);
    expect(storageBatch.commit).toHaveBeenCalledTimes(1);
    expect(storageBatch.abandon).toHaveBeenCalledOnce();
  });
});
