import { readFileSync, rmSync } from 'node:fs';
import { describe, expect, it, afterEach } from 'vitest';
import { MetricsCollector } from '../../../../src/application/observability/MetricsCollector.js';
import { AuditLogger } from '../../../../src/infrastructure/logging/AuditLogger.js';
import { MemorySampler } from '../../../../src/infrastructure/logging/MemorySampler.js';
import { StructuredLogger } from '../../../../src/infrastructure/logging/StructuredLogger.js';

const logRoot = 'testing/logging';

afterEach(() => {
  rmSync(logRoot, { recursive: true, force: true });
});

describe('TASK-MG-053: structured logging', () => {
  it('writes JSONL log entries with masked context', () => {
    const logger = new StructuredLogger(`${logRoot}/runtime.jsonl`);
    const entry = logger.log('info', 'OPENAI_API_KEY=sk-secret', { apiKey: 'sk-secret', corpusId: 'corpus-1' });
    const file = readFileSync(`${logRoot}/runtime.jsonl`, 'utf8').trim();

    expect(entry.level).toBe('info');
    expect(file).toContain('"level":"info"');
    expect(file).toContain('[REDACTED_SECRET]');
    expect(file).not.toContain('sk-secret');
  });

  it('records audit mutations through the structured logger', () => {
    const logger = new StructuredLogger(`${logRoot}/audit.jsonl`);
    const auditLogger = new AuditLogger(logger);
    auditLogger.recordMutation({ corpusId: 'corpus-1', action: 'delete_document', entityType: 'document', entityId: 'doc-1', detail: { reason: 'cleanup' } });

    const line = readFileSync(`${logRoot}/audit.jsonl`, 'utf8').trim();
    expect(line).toContain('delete_document:document');
    expect(line).toContain('"audit":true');
  });

  it('aggregates counters, timings, and rss samples', () => {
    const metrics = new MetricsCollector();
    metrics.increment('queries_total');
    metrics.increment('queries_total', 2);
    metrics.recordTiming('query_ms', 12);
    metrics.recordTiming('query_ms', 18);

    const snapshot = metrics.snapshot();
    const rss = new MemorySampler().sampleRss();

    expect(snapshot.counters['queries_total']).toBe(3);
    expect(snapshot.timings['query_ms']).toEqual({ count: 2, totalMs: 30, avgMs: 15 });
    expect(rss).toBeGreaterThan(0);
  });
});
