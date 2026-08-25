import type Database from 'better-sqlite3';
import type { IMemoryStore } from '../../domain/storage/index.js';
import type { JobError } from '../corpus/corpusDtos.js';
import type { IndexDocumentsCommand } from './IndexingService.js';

export interface ProcessDocumentResult {
  readonly processedDocumentId: string;
  readonly addedNodes: number;
  readonly addedEdges: number;
  readonly conflicts: number;
}

export interface DocumentIndexingPipeline {
  processDocument(
    corpusId: string,
    document: IndexDocumentsCommand['documents'][number],
  ): Promise<ProcessDocumentResult>;
}

export interface StorageWriteBatch {
  readonly begin: () => Promise<void>;
  readonly commit: () => Promise<void>;
  /** Invalidate the transport; only the external owner may recover the batch. */
  readonly abandon: () => Promise<void>;
}

export class DocumentMutationError extends Error {
  public readonly code = 'DOCUMENT_MUTATION_FAILED';

  public constructor(cause: unknown) {
    super('document mutation failed after persistence began', { cause });
    this.name = 'DocumentMutationError';
  }
}

const BATCH_COMMIT_EVERY_DOCS = 15;
const DOCUMENT_PROCESSING_FAILED = 'DOCUMENT_PROCESSING_FAILED';
const JOB_EXECUTION_FAILED = 'JOB_EXECUTION_FAILED';

export class AsyncJobRunner {
  private readonly jobs = new Map<string, IndexDocumentsCommand>();
  private readonly cancelled = new Set<string>();

  public constructor(
    private readonly db: Database.Database,
    private readonly memoryStore: IMemoryStore,
    private readonly pipeline: DocumentIndexingPipeline,
    private readonly storageBatch?: StorageWriteBatch,
  ) {}

  public registerJob(jobId: string, command: IndexDocumentsCommand): void {
    this.jobs.set(jobId, command);
  }

  /** Job ids owned by this process (for scoped shutdown cancellation). */
  public ownedJobIds(): readonly string[] {
    return [...this.jobs.keys()];
  }

  public async enqueue(jobId: string): Promise<void> {
    const command = this.jobs.get(jobId);
    if (!command) {
      throw new Error(`Unknown job ${jobId}`);
    }

    this.db.prepare(
      `INSERT OR REPLACE INTO jobs (job_id, corpus_id, status, total, processed, errors_json, summary, created_at, updated_at)
       VALUES (?, ?, 'pending', ?, 0, '[]', NULL, ?, ?)`,
    ).run(jobId, command.corpusId, command.documents.length, new Date().toISOString(), new Date().toISOString());
  }

  public async execute(jobId: string): Promise<void> {
    if (this.cancelled.has(jobId)) {
      return;
    }

    const command = this.jobs.get(jobId);
    if (!command) {
      throw new Error(`Unknown job ${jobId}`);
    }

    let batchState: 'none' | 'uncertain' | 'open' = 'none';
    const beginBatch = async (): Promise<void> => {
      if (!this.storageBatch) return;
      // A lost begin response can still have created an owner transaction.
      batchState = 'uncertain';
      await this.storageBatch.begin();
      batchState = 'open';
    };
    const commitOpenBatch = async (): Promise<void> => {
      if (!this.storageBatch || batchState === 'none') return;
      // A failed/lost commit response is not safe to retry or classify here.
      batchState = 'uncertain';
      await this.storageBatch.commit();
      batchState = 'none';
    };
    const abandonUnresolvedBatch = async (): Promise<void> => {
      if (!this.storageBatch || batchState === 'none') return;
      batchState = 'none';
      await this.storageBatch.abandon();
    };
    try {
      const checkpoint = await this.memoryStore.loadCheckpoint(jobId);
      const processed = new Set(checkpoint?.processedDocumentIds ?? []);

      this.db.prepare(
        `UPDATE jobs SET status = 'running', total = ?, processed = ?, updated_at = ? WHERE job_id = ?`,
      ).run(command.documents.length, processed.size, new Date().toISOString(), jobId);

      // Defer backend persistence to one write per BATCH_COMMIT_EVERY_DOCS
      // documents (aira-graphdb rewrites its whole file on every mutating RPC
      // otherwise). Data and checkpoints commit together, so a crash simply
      // replays the last uncommitted documents.
      await beginBatch();
      let sinceCommit = 0;
      let addedNodes = 0;
      let addedEdges = 0;
      let conflicts = 0;
      const documentErrors: JobError[] = [];

      for (const document of command.documents) {
        // Honor cancellations recorded in the DB (e.g. by an operator or
        // another process) — without this the process keeps working as a
        // zombie on a job whose row already says cancelled.
        const dbRow = this.db.prepare('SELECT status FROM jobs WHERE job_id = ?').get(jobId) as { status?: string } | undefined;
        if (dbRow?.status === 'cancelled') {
          this.cancelled.add(jobId);
        }
        if (this.cancelled.has(jobId)) {
          // Cancellation is observed only between documents. Previously
          // successful documents form a clean batch and may be committed.
          await commitOpenBatch();
          this.db.prepare(
            `UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE job_id = ?`,
          ).run(new Date().toISOString(), jobId);
          return;
        }
        if (processed.has(document.documentId)) {
          continue;
        }

        let result: ProcessDocumentResult;
        try {
          result = await this.pipeline.processDocument(command.corpusId, document);
        } catch (error) {
          if (error instanceof DocumentMutationError) {
            // A mutation may already be present in the backend WAL. Only the
            // owner/recovery authority may resolve it; never publish it here.
            throw error;
          }
          // Isolate per-document failures: one malformed document must not
          // abort the whole job. Record and continue.
          const message = error instanceof Error
            ? `${error.message}\n${(error.stack ?? '').split('\n').slice(1, 4).join('\n')}`
            : String(error);
          documentErrors.push({
            code: DOCUMENT_PROCESSING_FAILED,
            message,
            documentId: document.documentId,
          });
          console.log(`  [${document.title}] FAILED (skipping): ${message.split('\n')[0]}`);
          continue;
        }
        processed.add(result.processedDocumentId);
        addedNodes += result.addedNodes;
        addedEdges += result.addedEdges;
        conflicts += result.conflicts;

        await this.memoryStore.saveCheckpoint({
          jobId,
          corpusId: command.corpusId,
          processedDocumentIds: [...processed],
          updatedAt: new Date().toISOString(),
        });

        this.db.prepare(
          `UPDATE jobs SET processed = ?, updated_at = ? WHERE job_id = ?`,
        ).run(processed.size, new Date().toISOString(), jobId);

        sinceCommit += 1;
        if (this.storageBatch && sinceCommit >= BATCH_COMMIT_EVERY_DOCS) {
          await commitOpenBatch();
          await beginBatch();
          sinceCommit = 0;
        }
      }

      // The backend commit is part of the job's success boundary. A failed
      // final commit must leave the durable job row failed, never completed.
      await commitOpenBatch();
      this.db.prepare(
        `UPDATE jobs SET status = 'completed', processed = ?, summary = ?, errors_json = ?, updated_at = ? WHERE job_id = ?`,
      ).run(
        processed.size,
        JSON.stringify({ addedNodes, addedEdges, conflictCount: conflicts, skippedCount: command.documents.length - processed.size, documentErrorCount: documentErrors.length }),
        JSON.stringify(documentErrors),
        new Date().toISOString(),
        jobId,
      );
    } catch (error) {
      let failure = error;
      try {
        await abandonUnresolvedBatch();
      } catch (abandonError) {
        const originalMessage = error instanceof Error ? error.message : String(error);
        failure = new AggregateError(
          [error, abandonError],
          `job failed and storage batch abandon failed: ${originalMessage}`,
        );
      }
      // Record the stack, not just the message — message-only errors made
      // pipeline failures undiagnosable.
      const message = failure instanceof Error
        ? `${failure.message}\n${(failure.stack ?? '').split('\n').slice(1, 6).join('\n')}`
        : String(failure);
      const jobError: JobError = {
        code: JOB_EXECUTION_FAILED,
        message,
      };
      this.db.prepare(
        `UPDATE jobs SET status = 'failed', errors_json = ?, updated_at = ? WHERE job_id = ?`,
      ).run(JSON.stringify([jobError]), new Date().toISOString(), jobId);
      throw failure;
    }
  }

  public async cancel(jobId: string): Promise<void> {
    this.cancelled.add(jobId);
    this.db.prepare(
      `UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE job_id = ?`,
    ).run(new Date().toISOString(), jobId);
  }
}
