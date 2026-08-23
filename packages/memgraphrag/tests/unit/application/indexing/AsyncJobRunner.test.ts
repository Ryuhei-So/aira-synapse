import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IMemoryStore } from '../../../../src/domain/storage/index.js';
import { runMigrations } from '../../../../src/infrastructure/storage/migrate.js';
import { createNotImplementedStub } from '../../../setup/testDoubles.js';
import { AsyncJobRunner } from '../../../../src/application/indexing/AsyncJobRunner.js';
import { DefaultIndexingService } from '../../../../src/application/indexing/IndexingService.js';
import { AiraGraphDbNativeClient } from '../../../../src/infrastructure/storage/aira-graphdb/NativeClient.js';
import type { IndexDocumentsCommand } from '../../../../src/application/indexing/IndexingService.js';
import type { DeleteDocumentResult } from '../../../../src/application/indexing/DeleteDocumentService.js';

function command(documentId = 'doc-1'): IndexDocumentsCommand {
  return {
    corpusId: 'corpus-1',
    documents: [{
      documentId,
      markdown: '# Intro\nContent',
      title: 'Doc',
      sourceUrl: 'https://example.com/doc',
      sourceType: 'md',
      language: 'en',
    }],
  };
}

const fakeOwnerNative = fileURLToPath(new URL('../../../fixtures/fake-owner-native.mjs', import.meta.url));

const ownerErrorContract = JSON.parse(readFileSync(resolve(
  import.meta.dirname,
  '../../../fixtures/graphdb-owner-job-errors.json',
), 'utf8')) as {
  contract: string;
  version: number;
  ownerError: { code: string; documentId: string };
};

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

  it('records failures into the jobs table when processing throws', async () => {
    const pipeline = { processDocument: vi.fn().mockRejectedValue(new Error('boom')) };
    const runner = new AsyncJobRunner(db, memoryStore, pipeline);
    runner.registerJob('job-1', command());
    await runner.enqueue('job-1');
    await runner.execute('job-1');

    const row = db.prepare('SELECT status, errors_json FROM jobs WHERE job_id = ?').get('job-1') as { status: string; errors_json: string };
    expect(row.status).toBe('completed');
    expect(JSON.parse(row.errors_json)).toEqual([expect.objectContaining({
      code: 'DOCUMENT_ERROR',
      documentId: 'doc-1',
      message: expect.stringContaining('boom'),
    })]);
  });

  it('preserves typed infrastructure codes in per-document errors', async () => {
    expect(ownerErrorContract).toMatchObject({ contract: 'graphdb-owner-job-errors', version: 1 });
    const error = Object.assign(new Error('owner rejected mutation'), { code: ownerErrorContract.ownerError.code });
    const pipeline = { processDocument: vi.fn().mockRejectedValue(error) };
    const runner = new AsyncJobRunner(db, memoryStore, pipeline);
    runner.registerJob('job-1', command());
    await runner.enqueue('job-1');
    await runner.execute('job-1');

    const row = db.prepare('SELECT errors_json FROM jobs WHERE job_id = ?').get('job-1') as { errors_json: string };
    const serialized = JSON.parse(row.errors_json) as Array<{ code: string; documentId?: string; message: string }>;
    expect(serialized).toEqual([expect.objectContaining({
      code: ownerErrorContract.ownerError.code,
      documentId: 'doc-1',
      message: expect.stringContaining('owner rejected mutation'),
    })]);
    expect(serialized[0]).toEqual(expect.objectContaining({ documentId: 'doc-1' }));
  });

  it('serializes the real NativeClient owner error for Hub consumption', async () => {
    const previousCommand = process.env.AIRA_GRAPHDB_NATIVE_CMD;
    process.env.AIRA_GRAPHDB_NATIVE_CMD = `${process.execPath} ${fakeOwnerNative}`;
    const client = new AiraGraphDbNativeClient('/tmp/graphdb-owner-contract-test');
    const pipeline = {
      processDocument: vi.fn(async () => {
        await client.request('memory_upsert', { corpusId: 'corpus-1', delta: [] });
        return { processedDocumentId: 'doc_0123456789ab', addedNodes: 0, addedEdges: 0, conflicts: 0 };
      }),
    };
    try {
      const runner = new AsyncJobRunner(db, memoryStore, pipeline);
      runner.registerJob('job-owner-contract', command('doc_0123456789ab'));
      await runner.enqueue('job-owner-contract');
      await runner.execute('job-owner-contract');

      const row = db.prepare('SELECT errors_json FROM jobs WHERE job_id = ?')
        .get('job-owner-contract') as { errors_json: string };
      expect(JSON.parse(row.errors_json)).toEqual([expect.objectContaining({
        code: ownerErrorContract.ownerError.code,
        documentId: ownerErrorContract.ownerError.documentId,
      })]);
    } finally {
      await client.close();
      if (previousCommand === undefined) delete process.env.AIRA_GRAPHDB_NATIVE_CMD;
      else process.env.AIRA_GRAPHDB_NATIVE_CMD = previousCommand;
    }
  });
});
