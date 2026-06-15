/**
 * Infrastructure Layer — SQLite → LadybugDB migration script.
 * DES-LDB-007, REQ-LDB-006: Migrate all data from SQLite to LadybugDB.
 *
 * Idempotent: uses MERGE for node tables, skip-on-exists for edges.
 */

import type { IGraphStore, IMemoryStore, IVectorIndex } from '../../../domain/storage/graphStore.js';
import type { ILexicalRetriever } from '../../../domain/retrieval/ppr.js';

export interface MigrationSource {
  readonly graphStore: IGraphStore;
  readonly vectorIndex: IVectorIndex;
  readonly memoryStore: IMemoryStore;
  readonly lexicalRetriever: ILexicalRetriever;
}

export interface MigrationTarget {
  readonly graphStore: IGraphStore;
  readonly vectorIndex: IVectorIndex;
  readonly memoryStore: IMemoryStore;
  readonly lexicalRetriever: ILexicalRetriever;
}

export interface MigrationReport {
  readonly corpusId: string;
  readonly nodes: { source: number; target: number };
  readonly edges: { source: number; target: number };
  readonly schemas: { source: number; target: number };
  readonly facts: { source: number; target: number };
  readonly passages: { source: number; target: number };
  readonly durationMs: number;
  readonly errors: readonly string[];
}

/**
 * Migrate a single corpus from source (SQLite) to target (LadybugDB).
 */
export async function migrateCorpus(
  corpusId: string,
  source: MigrationSource,
  target: MigrationTarget,
): Promise<MigrationReport> {
  const startMs = Date.now();
  const errors: string[] = [];

  // 1. Migrate MemoryStore (schemas, facts, passages)
  let srcSnapshot;
  try {
    srcSnapshot = await source.memoryStore.load(corpusId);
    await target.memoryStore.save(srcSnapshot);
  } catch (err) {
    errors.push(`MemoryStore migration failed: ${(err as Error).message}`);
  }

  // 2. Migrate GraphStore nodes
  let srcNodes: readonly import('../../../domain/storage/graphStore.js').GraphNode[] | undefined;
  try {
    srcNodes = await source.graphStore.getNodes(corpusId);
    if (srcNodes.length > 0) {
      // Batch in chunks of 100
      for (let i = 0; i < srcNodes.length; i += 100) {
        const batch = srcNodes.slice(i, i + 100);
        await target.graphStore.upsertNodes(batch);
      }
    }
  } catch (err) {
    errors.push(`GraphStore nodes migration failed: ${(err as Error).message}`);
  }

  // 3. Migrate GraphStore edges
  let srcEdges: readonly import('../../../domain/storage/graphStore.js').GraphEdge[] | undefined;
  try {
    srcEdges = await source.graphStore.getEdges(corpusId);
    if (srcEdges.length > 0) {
      for (let i = 0; i < srcEdges.length; i += 100) {
        const batch = srcEdges.slice(i, i + 100);
        await target.graphStore.upsertEdges(batch);
      }
    }
  } catch (err) {
    errors.push(`GraphStore edges migration failed: ${(err as Error).message}`);
  }

  // 4. Migrate LexicalRetriever (re-index passages)
  try {
    if (srcSnapshot && srcSnapshot.passages.length > 0) {
      await target.lexicalRetriever.indexPassages(corpusId, srcSnapshot.passages);
    }
  } catch (err) {
    errors.push(`LexicalRetriever migration failed: ${(err as Error).message}`);
  }

  // 5. Verify counts
  let tgtNodes: readonly import('../../../domain/storage/graphStore.js').GraphNode[] | undefined;
  let tgtEdges: readonly import('../../../domain/storage/graphStore.js').GraphEdge[] | undefined;
  let tgtSnapshot: import('../../../domain/memory/globalMemory.js').MemorySnapshot | undefined;
  try {
    tgtNodes = await target.graphStore.getNodes(corpusId);
    tgtEdges = await target.graphStore.getEdges(corpusId);
    tgtSnapshot = await target.memoryStore.load(corpusId);
  } catch (err) {
    errors.push(`Verification failed: ${(err as Error).message}`);
  }

  return {
    corpusId,
    nodes: {
      source: srcNodes?.length ?? 0,
      target: tgtNodes?.length ?? 0,
    },
    edges: {
      source: srcEdges?.length ?? 0,
      target: tgtEdges?.length ?? 0,
    },
    schemas: {
      source: srcSnapshot?.schemas.length ?? 0,
      target: tgtSnapshot?.schemas.length ?? 0,
    },
    facts: {
      source: srcSnapshot?.facts.length ?? 0,
      target: tgtSnapshot?.facts.length ?? 0,
    },
    passages: {
      source: srcSnapshot?.passages.length ?? 0,
      target: tgtSnapshot?.passages.length ?? 0,
    },
    durationMs: Date.now() - startMs,
    errors,
  };
}

/**
 * Format a migration report for CLI output.
 */
export function formatMigrationReport(report: MigrationReport): string {
  const lines: string[] = [
    `\n=== Migration Report: ${report.corpusId} ===`,
    `Duration: ${report.durationMs}ms`,
    '',
    '| Data Type  | Source | Target | Match |',
    '|------------|--------|--------|-------|',
    `| Nodes      | ${report.nodes.source.toString().padStart(6)} | ${report.nodes.target.toString().padStart(6)} | ${report.nodes.source === report.nodes.target ? '  ✅  ' : '  ❌  '} |`,
    `| Edges      | ${report.edges.source.toString().padStart(6)} | ${report.edges.target.toString().padStart(6)} | ${report.edges.source === report.edges.target ? '  ✅  ' : '  ❌  '} |`,
    `| Schemas    | ${report.schemas.source.toString().padStart(6)} | ${report.schemas.target.toString().padStart(6)} | ${report.schemas.source === report.schemas.target ? '  ✅  ' : '  ❌  '} |`,
    `| Facts      | ${report.facts.source.toString().padStart(6)} | ${report.facts.target.toString().padStart(6)} | ${report.facts.source === report.facts.target ? '  ✅  ' : '  ❌  '} |`,
    `| Passages   | ${report.passages.source.toString().padStart(6)} | ${report.passages.target.toString().padStart(6)} | ${report.passages.source === report.passages.target ? '  ✅  ' : '  ❌  '} |`,
  ];

  if (report.errors.length > 0) {
    lines.push('', 'Errors:');
    for (const err of report.errors) {
      lines.push(`  - ${err}`);
    }
  }

  return lines.join('\n');
}
