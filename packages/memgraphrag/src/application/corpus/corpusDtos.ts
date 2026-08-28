/**
 * Application Layer — Corpus DTOs.
 * DES-MG-022: CorpusManager data transfer objects.
 */

import type { ConflictType } from '../../domain/agent/conflictDetection.js';
import type { ConflictResolutionState } from '../../domain/agent/conflictResolution.js';
import type { DictionaryStatistics } from '../../domain/dictionary/termDictionary.js';
import type { MemoryStatistics } from '../../domain/memory/globalMemory.js';

export interface CorpusInfo {
  readonly corpusId: string;
  readonly name: string;
  readonly description?: string;
  readonly documentCount: number;
  readonly nodeCount: number;
  readonly createdAt: string;
}

export interface DeleteCorpusResult {
  readonly corpusId: string;
  readonly cancelledJobs: number;
  readonly deletedDocuments: number;
  readonly deletedNodes: number;
  readonly deletedEdges: number;
  readonly deletedVectorRecords: number;
}

export interface CorpusStats {
  readonly memory: MemoryStatistics;
  readonly graph: {
    readonly nodeCount: number;
    readonly edgeCount: number;
    readonly connectedComponents: number;
  };
  readonly dictionaries: DictionaryStatistics;
  readonly documents: readonly {
    readonly documentId: string;
    readonly title: string;
    readonly indexedAt: string;
  }[];
}

export interface JobError {
  readonly code: string;
  readonly message: string;
  readonly documentId?: string;
}

export interface IndexingSummary {
  readonly addedNodes: number;
  readonly addedEdges: number;
  readonly conflictCount: number;
  readonly skippedCount: number;
  readonly chunkedMemoryDeltaDocuments?: number;
}

export interface JobSummary {
  readonly jobId: string;
  readonly status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  readonly processedCount: number;
  readonly totalCount: number;
  readonly errorCount: number;
  readonly errors?: readonly JobError[];
  readonly summary?: IndexingSummary;
}

export interface ConflictSummary {
  readonly conflictId: string;
  readonly type: ConflictType;
  readonly resolutionState: ConflictResolutionState;
  readonly confidence: number;
}

export interface ConflictAnalysis {
  readonly conflicts: readonly ConflictSummary[];
  readonly distribution: Readonly<Record<string, number>>;
}

export interface GraphExportPage {
  readonly format: 'graphml' | 'json';
  readonly data: string;
  readonly offset: number;
  readonly limit: number;
  readonly hasMore: boolean;
  readonly nextOffset?: number;
  readonly totalNodes: number;
}
