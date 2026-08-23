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
import type { AiraGraphDbNativeClient } from './NativeClient.js';

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
  // Per-corpus snapshot cache: the merged state lives here between saves, so
  // each per-document save costs one write RPC instead of a full round-trip
  // load of an ever-growing snapshot (which made indexing O(n^2)).
  private readonly snapshotCache = new Map<string, MemorySnapshot>();

  public constructor(private readonly client: AiraGraphDbNativeClient) {}

  public async load(corpusId: string): Promise<MemorySnapshot> {
    const cached = this.snapshotCache.get(corpusId);
    if (cached) {
      return cached;
    }
    const loaded = await this.client.request<MemorySnapshot>('memory_load', { corpusId });
    if (loaded) {
      this.snapshotCache.set(corpusId, loaded);
    }
    return loaded;
  }

  public async save(snapshot: MemorySnapshot): Promise<void> {
    // The native memory_save replaces the whole snapshot, but callers
    // (FullDocumentIndexingPipeline) save per-document increments and the
    // SQLite implementation upserts them. Merge with the stored snapshot so
    // earlier documents' passages/facts/schemas survive.
    let merged = snapshot;
    try {
      const existing = await this.load(snapshot.corpusId);
      if (existing) {
        const byId = <T>(items: readonly T[] | undefined, key: (item: T) => string): Map<string, T> => {
          const map = new Map<string, T>();
          for (const item of items ?? []) map.set(key(item), item);
          return map;
        };
        const passages = byId(existing.passages, (p: Passage) => p.passageId);
        for (const p of snapshot.passages ?? []) passages.set(p.passageId, p);
        const facts = byId(existing.facts, (f) => f.factId);
        for (const f of snapshot.facts ?? []) facts.set(f.factId, f);
        const schemas = byId(existing.schemas, (s) => s.schemaId);
        for (const s of snapshot.schemas ?? []) schemas.set(s.schemaId, s);
        merged = {
          ...snapshot,
          passages: [...passages.values()],
          facts: [...facts.values()],
          schemas: [...schemas.values()],
        };
      }
    } catch {
      // No existing snapshot (or unreadable) — save as-is.
    }
    this.snapshotCache.set(snapshot.corpusId, merged);
    try {
      // Send only this call's delta; the native side merges (O(delta) RPC
      // payload and WAL growth instead of O(corpus) per document).
      await this.client.request('memory_upsert', {
        corpusId: snapshot.corpusId,
        passages: snapshot.passages ?? [],
        facts: snapshot.facts ?? [],
        schemas: snapshot.schemas ?? [],
        exportedAt: snapshot.exportedAt,
      });
    } catch {
      // Older native binaries without memory_upsert: full-snapshot fallback.
      await this.client.request('memory_save', { snapshot: merged });
    }
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
