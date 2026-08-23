import type Database from 'better-sqlite3';
import type { JobError } from '../corpus/corpusDtos.js';
import type { IMemoryStore } from '../../domain/storage/index.js';
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
}

const BATCH_COMMIT_EVERY_DOCS = 15;

function errorCode(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error !== null
    && 'code' in error && typeof error.code === 'string' && error.code.length > 0) {
    return error.code;
  }
  return fallback;
}

function errorMessage(error: unknown, stackLines: number): string {
  return error instanceof Error
    ? `${error.message}\n${(error.stack ?? '').split('\n').slice(1, stackLines + 1).join('\n')}`
    : String(error);
}

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

    const checkpoint = await this.memoryStore.loadCheckpoint(jobId);
    const processed = new Set(checkpoint?.processedDocumentIds ?? []);

    this.db.prepare(
      `UPDATE jobs SET status = 'running', total = ?, processed = ?, updated_at = ? WHERE job_id = ?`,
    ).run(command.documents.length, processed.size, new Date().toISOString(), jobId);

    // Defer backend persistence to one write per BATCH_COMMIT_EVERY_DOCS
    // documents (aira-graphdb rewrites its whole file on every mutating RPC
    // otherwise). Data and checkpoints commit together, so a crash simply
    // replays the last uncommitted documents.
    await this.storageBatch?.begin();
    let sinceCommit = 0;
    try {
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
          // Isolate per-document failures: one malformed document must not
          // abort the whole job. Record and continue.
          const message = errorMessage(error, 3);
          documentErrors.push({
            code: errorCode(error, 'DOCUMENT_ERROR'),
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
          await this.storageBatch.commit();
          await this.storageBatch.begin();
          sinceCommit = 0;
        }
      }

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
      // Record the stack, not just the message — message-only errors made
      // pipeline failures undiagnosable.
      const message = errorMessage(error, 5);
      this.db.prepare(
        `UPDATE jobs SET status = 'failed', errors_json = ?, updated_at = ? WHERE job_id = ?`,
      ).run(JSON.stringify([{
        code: errorCode(error, 'JOB_ERROR'),
        message,
      }]), new Date().toISOString(), jobId);
    } finally {
      try {
        await this.storageBatch?.commit();
      } catch (err) {
        console.log(`  [job ${jobId}] final storage commit failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  public async cancel(jobId: string): Promise<void> {
    this.cancelled.add(jobId);
    this.db.prepare(
      `UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE job_id = ?`,
    ).run(new Date().toISOString(), jobId);
  }
}
