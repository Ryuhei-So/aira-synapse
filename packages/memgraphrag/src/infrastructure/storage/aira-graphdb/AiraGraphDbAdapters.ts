import type { Passage } from '../../../domain/memory/passage.js';
import type { IGraphProjection, ILexicalRetriever, TransitionEntry } from '../../../domain/retrieval/ppr.js';
import type {
  GraphEdge,
  GraphNode,
  IMemoryStore,
  IVectorIndex,
  JobCheckpoint,
  VectorRecord,
  VectorSearchMatch,
  VectorSearchRequest,
} from '../../../domain/storage/graphStore.js';
import type { MemorySnapshot } from '../../../domain/memory/globalMemory.js';
import type { IGraphStore } from '../../../domain/storage/graphStore.js';
import { AiraGraphDbNativeClient } from './NativeClient.js';

export class AiraGraphDbGraphStore implements IGraphStore {
  public constructor(private readonly client: AiraGraphDbNativeClient) {}

  public async upsertNodes(nodes: readonly GraphNode[]): Promise<void> {
    await this.client.request('upsert_nodes', { nodes });
  }

  public async upsertEdges(edges: readonly GraphEdge[]): Promise<void> {
    await this.client.request('upsert_edges', { edges });
  }

  public async getNode(corpusId: string, nodeId: string): Promise<GraphNode | null> {
    const node = await this.client.request<GraphNode | null>('get_node', { corpusId, nodeId });
    return node ?? null;
  }

  public async getNodes(corpusId: string, layer?: GraphNode['layer']): Promise<readonly GraphNode[]> {
    return this.client.request('get_nodes', { corpusId, layer });
  }

  public async getAdjacent(corpusId: string, nodeId: string): Promise<readonly GraphEdge[]> {
    return this.client.request('get_adjacent', { corpusId, nodeId });
  }

  public async getEdges(corpusId: string, sourceNodeId?: string): Promise<readonly GraphEdge[]> {
    return this.client.request('get_edges', { corpusId, sourceNodeId });
  }

  public async deleteNodes(corpusId: string, nodeIds: readonly string[]): Promise<number> {
    return this.client.request('delete_nodes', { corpusId, nodeIds });
  }

  public async deleteEdges(corpusId: string, edgeIds: readonly string[]): Promise<number> {
    return this.client.request('delete_edges', { corpusId, edgeIds });
  }

  public async deleteByDocument(corpusId: string, documentId: string): Promise<{ deletedNodes: number; deletedEdges: number }> {
    return this.client.request('delete_by_document', { corpusId, documentId });
  }

  public async deleteByCorpus(corpusId: string): Promise<{ deletedNodes: number; deletedEdges: number }> {
    return this.client.request('delete_by_corpus', { corpusId });
  }
}

export class AiraGraphDbVectorIndex implements IVectorIndex {
  public constructor(private readonly client: AiraGraphDbNativeClient) {}

  public async upsert<TMetadata extends Readonly<Record<string, unknown>>>(records: readonly VectorRecord<TMetadata>[]): Promise<void> {
    await this.client.request('vector_upsert', { records });
  }

  public async search<TMetadata extends Readonly<Record<string, unknown>>>(
    request: VectorSearchRequest,
  ): Promise<readonly VectorSearchMatch<TMetadata>[]> {
    return this.client.request('vector_search', request);
  }

  public async deleteByDocument(corpusId: string, documentId: string): Promise<void> {
    await this.client.request('vector_delete_by_document', { corpusId, documentId });
  }

  public async deleteByCorpus(corpusId: string): Promise<{ deleted: number }> {
    return this.client.request('vector_delete_by_corpus', { corpusId });
  }
}

export class AiraGraphDbMemoryStore implements IMemoryStore {
  public constructor(private readonly client: AiraGraphDbNativeClient) {}

  public async load(corpusId: string): Promise<MemorySnapshot> {
    return this.client.request('memory_load', { corpusId });
  }

  public async save(snapshot: MemorySnapshot): Promise<void> {
    await this.client.request('memory_save', { snapshot });
  }

  public async saveCheckpoint(checkpoint: JobCheckpoint): Promise<void> {
    await this.client.request('memory_save_checkpoint', { checkpoint });
  }

  public async loadCheckpoint(jobId: string): Promise<JobCheckpoint | null> {
    const checkpoint = await this.client.request<JobCheckpoint | null>('memory_load_checkpoint', { jobId });
    return checkpoint ?? null;
  }

  public async validateIntegrity(corpusId: string): Promise<readonly string[]> {
    return this.client.request('memory_validate_integrity', { corpusId });
  }
}

export class AiraGraphDbGraphProjection implements IGraphProjection {
  public constructor(private readonly client: AiraGraphDbNativeClient) {}

  public async *getTransitions(corpusId: string): AsyncIterable<TransitionEntry> {
    const transitions = await this.client.request<TransitionEntry[]>('projection_get_transitions', { corpusId });
    for (const item of transitions) {
      yield item;
    }
  }

  public async getDanglingNodes(corpusId: string): Promise<readonly string[]> {
    return this.client.request('projection_get_dangling_nodes', { corpusId });
  }

  public async getNodeCount(corpusId: string): Promise<number> {
    return this.client.request('projection_get_node_count', { corpusId });
  }
}

export class AiraGraphDbLexicalRetriever implements ILexicalRetriever {
  public constructor(private readonly client: AiraGraphDbNativeClient) {}

  public async indexPassages(corpusId: string, passages: readonly Passage[]): Promise<void> {
    await this.client.request('lexical_index_passages', { corpusId, passages });
  }

  public async search(corpusId: string, query: string, topK: number): Promise<readonly { passageId: string; score: number }[]> {
    return this.client.request('lexical_search', { corpusId, query, topK });
  }

  public async deleteByDocument(corpusId: string, documentId: string): Promise<void> {
    await this.client.request('lexical_delete_by_document', { corpusId, documentId });
  }

  public async deleteByCorpus(corpusId: string): Promise<{ deleted: number }> {
    return this.client.request('lexical_delete_by_corpus', { corpusId });
  }
}

export class AiraGraphDbIndexStatusManager {
  public constructor(private readonly client: AiraGraphDbNativeClient) {}

  public async save(corpusId: string, indexType: 'vector' | 'lexical', status: string): Promise<void> {
    await this.client.request('index_status_save', { corpusId, indexType, status });
  }

  public async load(corpusId: string, indexType: 'vector' | 'lexical'): Promise<string | null> {
    const result = await this.client.request<{ status: string | null }>('index_status_load', { corpusId, indexType });
    return result.status;
  }
}
