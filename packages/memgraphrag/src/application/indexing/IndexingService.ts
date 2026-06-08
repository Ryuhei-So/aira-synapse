import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { DeleteDocumentResult } from './DeleteDocumentService.js';
import type { AsyncJobRunner } from './AsyncJobRunner.js';
import type { IndexDocumentInput } from './StageIExtractor.js';

export interface IndexDocumentsCommand {
  readonly corpusId: string;
  readonly documents: readonly IndexDocumentInput[];
}

export interface IndexingService {
  start(command: IndexDocumentsCommand): Promise<{ readonly jobId: string }>;
  resume(jobId: string): Promise<void>;
  cancel(jobId: string): Promise<void>;
  deleteDocument(corpusId: string, documentId: string): Promise<DeleteDocumentResult>;
}

export interface DeleteDocumentPort {
  deleteDocument(corpusId: string, documentId: string): Promise<DeleteDocumentResult>;
}

export class DefaultIndexingService implements IndexingService {
  public constructor(
    private readonly db: Database.Database,
    private readonly jobRunner: AsyncJobRunner,
    private readonly deleteDocumentPort: DeleteDocumentPort,
  ) {}

  public async start(command: IndexDocumentsCommand): Promise<{ readonly jobId: string }> {
    const jobId = randomUUID();
    this.jobRunner.registerJob(jobId, command);
    await this.jobRunner.enqueue(jobId);

    this.db.prepare(
      `UPDATE jobs SET corpus_id = ?, total = ?, processed = 0, updated_at = ? WHERE job_id = ?`,
    ).run(command.corpusId, command.documents.length, new Date().toISOString(), jobId);

    return { jobId };
  }

  public async resume(jobId: string): Promise<void> {
    await this.jobRunner.execute(jobId);
  }

  public async cancel(jobId: string): Promise<void> {
    await this.jobRunner.cancel(jobId);
  }

  public async deleteDocument(
    corpusId: string,
    documentId: string,
  ): Promise<DeleteDocumentResult> {
    return this.deleteDocumentPort.deleteDocument(corpusId, documentId);
  }
}
