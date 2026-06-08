/**
 * Application Layer — CorpusManager.
 * DES-MG-022: Corpus lifecycle management (create/delete/list/stats/jobs/export).
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { IGraphStore } from '../../domain/storage/graphStore.js';
import type { IVectorIndex } from '../../domain/storage/graphStore.js';
import type { ITermDictionary } from '../../domain/dictionary/termDictionary.js';
import type {
  CorpusInfo,
  DeleteCorpusResult,
  CorpusStats,
  JobSummary,
  ConflictAnalysis,
  ConflictSummary,
  GraphExportPage,
  JobError,
  IndexingSummary,
} from './corpusDtos.js';
import type { ConflictType } from '../../domain/agent/conflictDetection.js';
import type { ConflictResolutionState } from '../../domain/agent/conflictResolution.js';

interface CorpusRow {
  readonly corpus_id: string;
  readonly name: string;
  readonly description: string | null;
  readonly created_at: string;
}

interface DocumentRow {
  readonly document_id: string;
  readonly title: string;
  readonly created_at: string;
}

interface JobRow {
  readonly job_id: string;
  readonly corpus_id: string;
  readonly status: JobSummary['status'];
  readonly processed: number;
  readonly total: number;
  readonly errors_json: string;
  readonly summary: string | null;
}

interface AuditLogRow {
  readonly conflict_id: number;
  readonly conflict_type: ConflictType;
  readonly resolution_state: ConflictResolutionState;
  readonly confidence: number;
}

interface GraphNodeMinRow {
  readonly node_id: string;
  readonly corpus_id: string;
  readonly layer: string;
  readonly ref_id: string;
  readonly label: string;
}

interface GraphEdgeMinRow {
  readonly source_node_id: string;
  readonly target_node_id: string;
}

export class CorpusManager {
  public constructor(
    private readonly db: Database.Database,
    private readonly graphStore: IGraphStore,
    private readonly vectorIndex: IVectorIndex,
    private readonly termDictionary: ITermDictionary,
  ) {}

  // --- Lifecycle (TASK-MG-028) ---

  public async create(
    name: string,
    description?: string,
  ): Promise<CorpusInfo> {
    const corpusId = randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO corpora (corpus_id, name, description, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(corpusId, name, description ?? null, now);

    return {
      corpusId,
      name,
      description,
      documentCount: 0,
      nodeCount: 0,
      createdAt: now,
    };
  }

  public async list(): Promise<readonly CorpusInfo[]> {
    const rows = this.db
      .prepare(
        `SELECT corpus_id, name, description, created_at
         FROM corpora
         ORDER BY created_at DESC`,
      )
      .all() as CorpusRow[];

    return rows.map((row) => {
      const docCount = (
        this.db
          .prepare(
            'SELECT COUNT(*) as cnt FROM documents WHERE corpus_id = ?',
          )
          .get(row.corpus_id) as { cnt: number }
      ).cnt;
      const nodeCount = (
        this.db
          .prepare(
            'SELECT COUNT(*) as cnt FROM graph_nodes WHERE corpus_id = ?',
          )
          .get(row.corpus_id) as { cnt: number }
      ).cnt;

      return {
        corpusId: row.corpus_id,
        name: row.name,
        description: row.description ?? undefined,
        documentCount: docCount,
        nodeCount,
        createdAt: row.created_at,
      };
    });
  }

  public async delete(corpusId: string): Promise<DeleteCorpusResult> {
    // 1. Cancel active jobs
    const cancelledJobs = this.db
      .prepare(
        `UPDATE jobs SET status = 'cancelled'
         WHERE corpus_id = ? AND status IN ('pending', 'running')`,
      )
      .run(corpusId).changes;

    // 2. Delete vector records
    const namespaces = ['schema', 'fact', 'passage', 'entity'] as const;
    let deletedVectorRecords = 0;
    for (const _ns of namespaces) {
      try {
        // Vector index doesn't expose a deleteByCorpus directly,
        // but we can iterate documents and delete per-document
        const docRows = this.db
          .prepare('SELECT document_id FROM documents WHERE corpus_id = ?')
          .all(corpusId) as { document_id: string }[];
        for (const doc of docRows) {
          await this.vectorIndex.deleteByDocument(corpusId, doc.document_id);
          deletedVectorRecords++;
        }
        break; // Only need to iterate docs once
      } catch {
        // Vector cleanup is best-effort
      }
    }

    // 3. Delete graph edges → nodes
    const graphResult = await this.graphStore.deleteByCorpus(corpusId);

    // 4. Delete passages, facts, schemas, documents, etc.
    const deletedDocuments = this.db
      .prepare('DELETE FROM documents WHERE corpus_id = ?')
      .run(corpusId).changes;

    // Clean up related tables
    this.db.prepare('DELETE FROM passages WHERE corpus_id = ?').run(corpusId);
    this.db.prepare('DELETE FROM facts WHERE corpus_id = ?').run(corpusId);
    this.db.prepare('DELETE FROM schemas WHERE corpus_id = ?').run(corpusId);
    this.db
      .prepare('DELETE FROM term_dictionary WHERE corpus_id = ?')
      .run(corpusId);
    this.db
      .prepare('DELETE FROM thesaurus_relations WHERE corpus_id = ?')
      .run(corpusId);
    this.db
      .prepare('DELETE FROM dictionary_candidates WHERE corpus_id = ?')
      .run(corpusId);
    this.db.prepare('DELETE FROM jobs WHERE corpus_id = ?').run(corpusId);
    this.db.prepare('DELETE FROM audit_logs WHERE corpus_id = ?').run(corpusId);

    // 5. Delete corpus record
    this.db
      .prepare('DELETE FROM corpora WHERE corpus_id = ?')
      .run(corpusId);

    return {
      corpusId,
      cancelledJobs,
      deletedDocuments,
      deletedNodes: graphResult.deletedNodes,
      deletedEdges: graphResult.deletedEdges,
      deletedVectorRecords,
    };
  }

  // --- Read APIs (TASK-MG-029) ---

  public async getStats(corpusId: string): Promise<CorpusStats> {
    // Compute memory statistics from SQLite directly
    const totalSchemas = (
      this.db.prepare('SELECT COUNT(*) as cnt FROM schemas WHERE corpus_id = ?').get(corpusId) as { cnt: number }
    ).cnt;
    const stableSchemas = (
      this.db.prepare("SELECT COUNT(*) as cnt FROM schemas WHERE corpus_id = ? AND state = 'stable'").get(corpusId) as { cnt: number }
    ).cnt;
    const totalFacts = (
      this.db.prepare('SELECT COUNT(*) as cnt FROM facts WHERE corpus_id = ?').get(corpusId) as { cnt: number }
    ).cnt;
    const activeFacts = (
      this.db.prepare("SELECT COUNT(*) as cnt FROM facts WHERE corpus_id = ? AND state = 'active'").get(corpusId) as { cnt: number }
    ).cnt;
    const inactiveFacts = (
      this.db.prepare("SELECT COUNT(*) as cnt FROM facts WHERE corpus_id = ? AND state = 'inactive'").get(corpusId) as { cnt: number }
    ).cnt;
    const totalPassages = (
      this.db.prepare('SELECT COUNT(*) as cnt FROM passages WHERE corpus_id = ?').get(corpusId) as { cnt: number }
    ).cnt;
    const linkedFacts = (
      this.db.prepare(
        `SELECT COUNT(DISTINCT f.fact_id) as cnt FROM facts f
         JOIN fact_passages fp ON f.fact_id = fp.fact_id
         WHERE f.corpus_id = ?`,
      ).get(corpusId) as { cnt: number }
    ).cnt;

    const nodeCount = (
      this.db
        .prepare('SELECT COUNT(*) as cnt FROM graph_nodes WHERE corpus_id = ?')
        .get(corpusId) as { cnt: number }
    ).cnt;

    const edgeCount = (
      this.db
        .prepare('SELECT COUNT(*) as cnt FROM graph_edges WHERE corpus_id = ?')
        .get(corpusId) as { cnt: number }
    ).cnt;

    const connectedComponents = this.computeConnectedComponents(corpusId);

    const dictStats = await this.termDictionary.getStatistics();

    const documents = (
      this.db
        .prepare(
          `SELECT document_id, title, created_at
           FROM documents
           WHERE corpus_id = ?
           ORDER BY created_at DESC`,
        )
        .all(corpusId) as DocumentRow[]
    ).map((row) => ({
      documentId: row.document_id,
      title: row.title,
      indexedAt: row.created_at,
    }));

    return {
      memory: {
        corpusId,
        totalSchemas,
        stableSchemas,
        totalFacts,
        activeFacts,
        inactiveFacts,
        totalPassages,
        linkedFacts,
        detectedConflicts: 0,
        resolvedConflicts: 0,
        connectedComponents,
      },
      graph: { nodeCount, edgeCount, connectedComponents },
      dictionaries: dictStats,
      documents,
    };
  }

  public async getJobStatus(jobId: string): Promise<JobSummary> {
    const row = this.db
      .prepare(
        `SELECT job_id, corpus_id, status, processed, total,
                errors_json, summary
         FROM jobs
         WHERE job_id = ?`,
      )
      .get(jobId) as JobRow | undefined;

    if (!row) {
      throw new Error(`Job not found: ${jobId}`);
    }

    return this.toJobSummary(row);
  }

  public async cancelJob(
    jobId: string,
  ): Promise<{ readonly jobId: string; readonly status: 'cancelled' }> {
    const result = this.db
      .prepare(
        `UPDATE jobs SET status = 'cancelled'
         WHERE job_id = ? AND status IN ('pending', 'running')`,
      )
      .run(jobId);

    if (result.changes === 0) {
      throw new Error(
        `Cannot cancel job ${jobId}: not found or already completed`,
      );
    }

    return { jobId, status: 'cancelled' };
  }

  public async analyzeConflicts(corpusId: string): Promise<ConflictAnalysis> {
    const rows = this.db
      .prepare(
        `SELECT
           log_id as conflict_id,
           json_extract(detail, '$.conflictType') as conflict_type,
           json_extract(detail, '$.resolutionState') as resolution_state,
           json_extract(detail, '$.confidence') as confidence
         FROM audit_logs
         WHERE corpus_id = ? AND action = 'conflict_resolution'
         ORDER BY created_at DESC`,
      )
      .all(corpusId) as AuditLogRow[];

    const conflicts: ConflictSummary[] = rows.map((row) => ({
      conflictId: String(row.conflict_id),
      type: row.conflict_type,
      resolutionState: row.resolution_state,
      confidence: row.confidence ?? 0,
    }));

    const distribution: Record<string, number> = {};
    for (const c of conflicts) {
      const key = c.resolutionState;
      distribution[key] = (distribution[key] ?? 0) + 1;
    }

    return { conflicts, distribution };
  }

  public async exportGraph(
    corpusId: string,
    format: 'graphml' | 'json',
    offset: number,
    limit: number,
  ): Promise<GraphExportPage> {
    const totalNodes = (
      this.db
        .prepare('SELECT COUNT(*) as cnt FROM graph_nodes WHERE corpus_id = ?')
        .get(corpusId) as { cnt: number }
    ).cnt;

    const nodeRows = this.db
      .prepare(
        `SELECT node_id, corpus_id, layer, ref_id, label
         FROM graph_nodes
         WHERE corpus_id = ?
         ORDER BY node_id
         LIMIT ? OFFSET ?`,
      )
      .all(corpusId, limit, offset) as GraphNodeMinRow[];

    const hasMore = offset + limit < totalNodes;
    const nextOffset = hasMore ? offset + limit : undefined;

    let data: string;
    if (format === 'json') {
      const nodes = nodeRows.map((r) => ({
        id: r.node_id,
        layer: r.layer,
        label: r.label,
      }));
      const edgeRows = this.db
        .prepare(
          `SELECT source_node_id, target_node_id
           FROM graph_edges
           WHERE corpus_id = ?`,
        )
        .all(corpusId) as GraphEdgeMinRow[];
      const edges = edgeRows.map((r) => ({
        source: r.source_node_id,
        target: r.target_node_id,
      }));
      data = JSON.stringify({ nodes, edges });
    } else {
      // GraphML format
      const lines: string[] = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<graphml xmlns="http://graphml.graphstruct.org/xmlns">',
        '<graph edgedefault="directed">',
      ];
      for (const row of nodeRows) {
        lines.push(
          `  <node id="${escapeXml(row.node_id)}"><data key="layer">${escapeXml(row.layer)}</data><data key="label">${escapeXml(row.label)}</data></node>`,
        );
      }
      if (offset === 0) {
        const edgeRows = this.db
          .prepare(
            `SELECT source_node_id, target_node_id
             FROM graph_edges
             WHERE corpus_id = ?`,
          )
          .all(corpusId) as GraphEdgeMinRow[];
        for (const edge of edgeRows) {
          lines.push(
            `  <edge source="${escapeXml(edge.source_node_id)}" target="${escapeXml(edge.target_node_id)}"/>`,
          );
        }
      }
      lines.push('</graph>', '</graphml>');
      data = lines.join('\n');
    }

    return {
      format,
      data,
      offset,
      limit,
      hasMore,
      nextOffset,
      totalNodes,
    };
  }

  // --- Private helpers ---

  private computeConnectedComponents(corpusId: string): number {
    const nodeRows = this.db
      .prepare('SELECT node_id FROM graph_nodes WHERE corpus_id = ?')
      .all(corpusId) as { node_id: string }[];

    if (nodeRows.length === 0) return 0;

    const edgeRows = this.db
      .prepare(
        `SELECT source_node_id, target_node_id
         FROM graph_edges
         WHERE corpus_id = ?`,
      )
      .all(corpusId) as GraphEdgeMinRow[];

    // Union-Find
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let root = x;
      while (parent.get(root) !== root) {
        root = parent.get(root) ?? root;
      }
      // Path compression
      let current = x;
      while (current !== root) {
        const next = parent.get(current) ?? current;
        parent.set(current, root);
        current = next;
      }
      return root;
    };
    const union = (a: string, b: string): void => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };

    for (const row of nodeRows) {
      parent.set(row.node_id, row.node_id);
    }
    for (const edge of edgeRows) {
      if (parent.has(edge.source_node_id) && parent.has(edge.target_node_id)) {
        union(edge.source_node_id, edge.target_node_id);
      }
    }

    const roots = new Set<string>();
    for (const row of nodeRows) {
      roots.add(find(row.node_id));
    }
    return roots.size;
  }

  private toJobSummary(row: JobRow): JobSummary {
    const parsedErrors = JSON.parse(row.errors_json) as JobError[];
    const errors = parsedErrors.length > 0 ? parsedErrors : undefined;
    const summary = row.summary
      ? (JSON.parse(row.summary) as IndexingSummary)
      : undefined;

    return {
      jobId: row.job_id,
      status: row.status,
      processedCount: row.processed,
      totalCount: row.total,
      errorCount: parsedErrors.length,
      errors,
      summary,
    };
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
