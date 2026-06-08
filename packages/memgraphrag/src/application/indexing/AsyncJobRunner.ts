import type Database from 'better-sqlite3';
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

export class AsyncJobRunner {
  private readonly jobs = new Map<string, IndexDocumentsCommand>();
  private readonly cancelled = new Set<string>();

  public constructor(
    private readonly db: Database.Database,
    private readonly memoryStore: IMemoryStore,
    private readonly pipeline: DocumentIndexingPipeline,
  ) {}

  public registerJob(jobId: string, command: IndexDocumentsCommand): void {
    this.jobs.set(jobId, command);
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

    try {
      let addedNodes = 0;
      let addedEdges = 0;
      let conflicts = 0;

      for (const document of command.documents) {
        if (this.cancelled.has(jobId)) {
          this.db.prepare(
            `UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE job_id = ?`,
          ).run(new Date().toISOString(), jobId);
          return;
        }
        if (processed.has(document.documentId)) {
          continue;
        }

        const result = await this.pipeline.processDocument(command.corpusId, document);
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
      }

      this.db.prepare(
        `UPDATE jobs SET status = 'completed', processed = ?, summary = ?, updated_at = ? WHERE job_id = ?`,
      ).run(
        processed.size,
        JSON.stringify({ addedNodes, addedEdges, conflictCount: conflicts, skippedCount: command.documents.length - processed.size }),
        new Date().toISOString(),
        jobId,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db.prepare(
        `UPDATE jobs SET status = 'failed', errors_json = ?, updated_at = ? WHERE job_id = ?`,
      ).run(JSON.stringify([message]), new Date().toISOString(), jobId);
    }
  }

  public async cancel(jobId: string): Promise<void> {
    this.cancelled.add(jobId);
    this.db.prepare(
      `UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE job_id = ?`,
    ).run(new Date().toISOString(), jobId);
  }
}
