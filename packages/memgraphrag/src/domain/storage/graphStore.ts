/**
 * Domain Layer — Storage ports (IGraphStore, IVectorIndex, IMemoryStore).
 * DES-MG-010: Persistence abstractions.
 */

import type { BridgeKind, MemoryLayer } from '../memory/types.js';
import type { Schema } from '../memory/schema.js';
import type { Fact } from '../memory/fact.js';
import type { Passage } from '../memory/passage.js';
import type { MemorySnapshot } from '../memory/globalMemory.js';

// --- Graph Store ---

export interface GraphNode<
  TRef extends Schema | Fact | Passage | Record<string, unknown> = Schema | Fact | Passage | Record<string, unknown>,
> {
  readonly nodeId: string;
  readonly corpusId: string;
  readonly layer: MemoryLayer;
  readonly ref: TRef;
  readonly label: string;
}

export interface GraphEdge {
  readonly edgeId: string;
  readonly corpusId: string;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly relation:
    | 'schema_instance'
    | 'fact_evidence'
    | 'type_based_bridge'
    | 'similarity_bridge'
    | 'entity_cooccurrence'
    | 'entity_mention'
    | 'is_a'
    | 'part_of';
  readonly weight: number;
  readonly bridgeKind?: BridgeKind;
}

export interface IGraphStore {
  upsertNodes(nodes: readonly GraphNode[]): Promise<void>;
  upsertEdges(edges: readonly GraphEdge[]): Promise<void>;
  getNode(corpusId: string, nodeId: string): Promise<GraphNode | null>;
  getNodes(
    corpusId: string,
    layer?: MemoryLayer,
  ): Promise<readonly GraphNode[]>;
  getAdjacent(
    corpusId: string,
    nodeId: string,
  ): Promise<readonly GraphEdge[]>;
  getEdges(
    corpusId: string,
    sourceNodeId?: string,
  ): Promise<readonly GraphEdge[]>;
  deleteNodes(
    corpusId: string,
    nodeIds: readonly string[],
  ): Promise<number>;
  deleteEdges(
    corpusId: string,
    edgeIds: readonly string[],
  ): Promise<number>;
  deleteByDocument(
    corpusId: string,
    documentId: string,
  ): Promise<{ deletedNodes: number; deletedEdges: number }>;
  deleteByCorpus(
    corpusId: string,
  ): Promise<{ deletedNodes: number; deletedEdges: number }>;
}

// --- Vector Index ---

export interface VectorRecord<
  TMetadata extends Readonly<Record<string, unknown>>,
> {
  readonly id: string;
  readonly corpusId: string;
  readonly namespace: 'schema' | 'fact' | 'passage' | 'entity';
  readonly values: readonly number[];
  readonly metadata: TMetadata;
}

export interface VectorSearchRequest {
  readonly corpusId: string;
  readonly namespace: 'schema' | 'fact' | 'passage' | 'entity';
  readonly queryVector: readonly number[];
  readonly topK: number;
  readonly threshold?: number;
}

export interface VectorSearchMatch<
  TMetadata extends Readonly<Record<string, unknown>>,
> {
  readonly id: string;
  readonly score: number;
  readonly metadata: TMetadata;
}

export interface IVectorIndex {
  upsert<TMetadata extends Readonly<Record<string, unknown>>>(
    records: readonly VectorRecord<TMetadata>[],
  ): Promise<void>;
  search<TMetadata extends Readonly<Record<string, unknown>>>(
    request: VectorSearchRequest,
  ): Promise<readonly VectorSearchMatch<TMetadata>[]>;
  deleteByDocument(corpusId: string, documentId: string): Promise<void>;
}

// --- Memory Store ---

export interface JobCheckpoint {
  readonly jobId: string;
  readonly corpusId: string;
  readonly processedDocumentIds: readonly string[];
  readonly updatedAt: string;
}

export interface IMemoryStore {
  load(corpusId: string): Promise<MemorySnapshot>;
  save(snapshot: MemorySnapshot): Promise<void>;
  saveCheckpoint(checkpoint: JobCheckpoint): Promise<void>;
  loadCheckpoint(jobId: string): Promise<JobCheckpoint | null>;
  validateIntegrity(corpusId: string): Promise<readonly string[]>;
}
