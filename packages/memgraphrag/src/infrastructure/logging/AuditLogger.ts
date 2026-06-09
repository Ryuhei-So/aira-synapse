import { StructuredLogger } from './StructuredLogger.js';

export interface AuditRecord {
  readonly corpusId: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export class AuditLogger {
  public constructor(private readonly logger: StructuredLogger) {}

  public recordMutation(record: AuditRecord): void {
    this.logger.log('info', `${record.action}:${record.entityType}`, {
      audit: true,
      ...record,
    });
  }
}
