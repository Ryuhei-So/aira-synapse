/**
 * Unit tests for CorpusManager read APIs (stats/export/job/conflict).
 * TASK-MG-029: DES-MG-022.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { CorpusManager } from '../../../../src/application/corpus/CorpusManager.js';
import { SQLiteGraphStore } from '../../../../src/infrastructure/storage/SQLiteGraphStore.js';
import { SQLiteLexiconStore } from '../../../../src/infrastructure/storage/SQLiteLexiconStore.js';
import { runMigrations } from '../../../../src/infrastructure/storage/migrate.js';
import { FileVectorIndex } from '../../../../src/infrastructure/storage/FileVectorIndex.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('CorpusManager reads', () => {
  let db: Database.Database;
  let manager: CorpusManager;
  let tmpDir: string;
  let corpusId: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-reads-'));
    const graphStore = new SQLiteGraphStore(db);
    const vectorIndex = new FileVectorIndex(tmpDir, 3);
    const lexiconStore = new SQLiteLexiconStore(db, 'test-corpus');

    manager = new CorpusManager(
      db,
      graphStore,
      vectorIndex,
      lexiconStore,
    );

    const corpus = await manager.create('Test Corpus');
    corpusId = corpus.corpusId;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('getStats', () => {
    it('should return stats for an empty corpus', async () => {
      const stats = await manager.getStats(corpusId);

      expect(stats.memory).toBeDefined();
      expect(stats.graph.nodeCount).toBe(0);
      expect(stats.graph.edgeCount).toBe(0);
      expect(stats.graph.connectedComponents).toBe(0);
      expect(stats.documents).toHaveLength(0);
    });

    it('should count documents and graph elements', async () => {
      // Insert a document
      db.prepare(
        `INSERT INTO documents (document_id, corpus_id, title, source_url)
         VALUES (?, ?, ?, ?)`,
      ).run('d1', corpusId, 'Paper A', 'https://example.com/a');

      // Insert graph nodes and edges
      const graphStore = new SQLiteGraphStore(db);
      await graphStore.upsertNodes([
        { nodeId: 'n1', corpusId, layer: 'ontology', ref: {} as any, label: 'A' },
        { nodeId: 'n2', corpusId, layer: 'fact', ref: {} as any, label: 'B' },
      ]);
      await graphStore.upsertEdges([
        {
          edgeId: 'e1',
          corpusId,
          sourceNodeId: 'n1',
          targetNodeId: 'n2',
          relation: 'schema_instance',
          weight: 1.0,
        },
      ]);

      const stats = await manager.getStats(corpusId);

      expect(stats.graph.nodeCount).toBe(2);
      expect(stats.graph.edgeCount).toBe(1);
      expect(stats.graph.connectedComponents).toBe(1);
      expect(stats.documents).toHaveLength(1);
      expect(stats.documents[0]!.title).toBe('Paper A');
    });
  });

  describe('getJobStatus', () => {
    it('should return job summary', async () => {
      db.prepare(
        `INSERT INTO jobs (job_id, corpus_id, status, processed, total, summary)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        'job-1',
        corpusId,
        'completed',
        10,
        10,
        JSON.stringify({ addedNodes: 20, addedEdges: 15, conflictCount: 2, skippedCount: 1 }),
      );

      const job = await manager.getJobStatus('job-1');

      expect(job.jobId).toBe('job-1');
      expect(job.status).toBe('completed');
      expect(job.processedCount).toBe(10);
      expect(job.summary?.addedNodes).toBe(20);
    });

    it('should throw on unknown job', async () => {
      await expect(manager.getJobStatus('unknown')).rejects.toThrow(
        'Job not found',
      );
    });
  });

  describe('cancelJob', () => {
    it('should cancel a pending job', async () => {
      db.prepare(
        `INSERT INTO jobs (job_id, corpus_id, status, processed, total)
         VALUES (?, ?, ?, ?, ?)`,
      ).run('j-cancel', corpusId, 'pending', 0, 5);

      const result = await manager.cancelJob('j-cancel');
      expect(result.status).toBe('cancelled');
    });

    it('should throw when cancelling completed job', async () => {
      db.prepare(
        `INSERT INTO jobs (job_id, corpus_id, status, processed, total)
         VALUES (?, ?, ?, ?, ?)`,
      ).run('j-done', corpusId, 'completed', 5, 5);

      await expect(manager.cancelJob('j-done')).rejects.toThrow(
        'Cannot cancel',
      );
    });
  });

  describe('analyzeConflicts', () => {
    it('should return empty analysis for corpus without conflicts', async () => {
      const analysis = await manager.analyzeConflicts(corpusId);
      expect(analysis.conflicts).toHaveLength(0);
      expect(analysis.distribution).toEqual({});
    });

    it('should aggregate conflict data from audit logs', async () => {
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO audit_logs (corpus_id, action, entity_type, entity_id, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        corpusId,
        'conflict_resolution',
        'fact',
        'f-1',
        JSON.stringify({
          conflictType: 'mutually_exclusive',
          resolutionState: 'resolved_keep_new',
          confidence: 0.85,
        }),
        now,
      );
      db.prepare(
        `INSERT INTO audit_logs (corpus_id, action, entity_type, entity_id, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        corpusId,
        'conflict_resolution',
        'fact',
        'f-2',
        JSON.stringify({
          conflictType: 'temporal',
          resolutionState: 'temporalized',
          confidence: 0.9,
        }),
        now,
      );

      const analysis = await manager.analyzeConflicts(corpusId);
      expect(analysis.conflicts).toHaveLength(2);
      expect(analysis.distribution['resolved_keep_new']).toBe(1);
      expect(analysis.distribution['temporalized']).toBe(1);
    });
  });

  describe('exportGraph', () => {
    it('should export empty graph as JSON', async () => {
      const page = await manager.exportGraph(corpusId, 'json', 0, 100);

      expect(page.format).toBe('json');
      expect(page.totalNodes).toBe(0);
      expect(page.hasMore).toBe(false);
      const parsed = JSON.parse(page.data) as { nodes: unknown[]; edges: unknown[] };
      expect(parsed.nodes).toHaveLength(0);
    });

    it('should export graph with pagination', async () => {
      const graphStore = new SQLiteGraphStore(db);
      await graphStore.upsertNodes([
        { nodeId: 'n1', corpusId, layer: 'ontology', ref: {} as any, label: 'A' },
        { nodeId: 'n2', corpusId, layer: 'fact', ref: {} as any, label: 'B' },
        { nodeId: 'n3', corpusId, layer: 'passage', ref: {} as any, label: 'C' },
      ]);

      const page1 = await manager.exportGraph(corpusId, 'json', 0, 2);
      expect(page1.totalNodes).toBe(3);
      expect(page1.hasMore).toBe(true);
      expect(page1.nextOffset).toBe(2);

      const page2 = await manager.exportGraph(corpusId, 'json', 2, 2);
      expect(page2.hasMore).toBe(false);
      expect(page2.nextOffset).toBeUndefined();
    });

    it('should export as GraphML', async () => {
      const graphStore = new SQLiteGraphStore(db);
      await graphStore.upsertNodes([
        { nodeId: 'n1', corpusId, layer: 'ontology', ref: {} as any, label: 'Test' },
      ]);

      const page = await manager.exportGraph(corpusId, 'graphml', 0, 100);
      expect(page.format).toBe('graphml');
      expect(page.data).toContain('<?xml');
      expect(page.data).toContain('graphml');
      expect(page.data).toContain('n1');
    });
  });
});
