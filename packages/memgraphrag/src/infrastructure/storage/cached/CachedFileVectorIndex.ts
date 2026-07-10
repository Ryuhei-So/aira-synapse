/**
 * CachedFileVectorIndex — Pre-loads all vector buffers, manifests, and metadata
 * into memory. Eliminates repeated readFileSync() on ~500MB binary data per search.
 *
 * The original FileVectorIndex reads vectors.f32 from disk on every search() call
 * and does O(n) JSON.parse per metadata entry. This cached version loads once per
 * namespace and keeps everything in memory for brute-force cosine similarity search.
 *
 * Read-only: upsert/delete throw. Use for benchmark and query-only workloads.
 */
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { resolveWithin } from '../pathSafety.js';
import type {
  IVectorIndex,
  VectorRecord,
  VectorSearchRequest,
  VectorSearchMatch,
} from '../../../domain/storage/graphStore.js';

interface ManifestEntry {
  readonly id: string;
  readonly offset: number;
  readonly dimensions: number;
  readonly deleted?: boolean;
}

interface NamespaceCache {
  readonly activeEntries: ManifestEntry[];
  readonly vectorBuffer: Buffer | null;
  readonly metadataMap: Map<string, Record<string, unknown>>;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export class CachedFileVectorIndex implements IVectorIndex {
  private readonly baseDir: string;
  private readonly nsCache = new Map<string, NamespaceCache | null>();

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  private ensureNs(corpusId: string, namespace: string): NamespaceCache | null {
    const key = `${corpusId}:${namespace}`;
    if (this.nsCache.has(key)) return this.nsCache.get(key)!;

    const nsDir = resolveWithin(this.baseDir, corpusId, namespace);
    if (!existsSync(nsDir)) {
      this.nsCache.set(key, null);
      return null;
    }

    const manifestPath = resolve(nsDir, 'manifest.json');
    if (!existsSync(manifestPath)) {
      this.nsCache.set(key, null);
      return null;
    }

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const activeEntries: ManifestEntry[] = manifest.entries.filter(
      (e: ManifestEntry) => !e.deleted,
    );

    const vectorsPath = resolve(nsDir, 'vectors.f32');
    const vectorBuffer = existsSync(vectorsPath)
      ? readFileSync(vectorsPath)
      : null;

    const metadataPath = resolve(nsDir, 'metadata.jsonl');
    const metadataMap = new Map<string, Record<string, unknown>>();
    if (existsSync(metadataPath)) {
      const lines = readFileSync(metadataPath, 'utf-8').trim().split('\n');
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as { id: string };
          metadataMap.set(parsed.id, parsed);
        } catch {
          /* skip malformed lines */
        }
      }
    }

    const cached: NamespaceCache = { activeEntries, vectorBuffer, metadataMap };
    this.nsCache.set(key, cached);
    return cached;
  }

  async search<TMetadata extends Readonly<Record<string, unknown>>>(
    request: VectorSearchRequest,
  ): Promise<readonly VectorSearchMatch<TMetadata>[]> {
    const ns = this.ensureNs(request.corpusId, request.namespace);
    if (!ns || !ns.vectorBuffer) return [];

    const queryVec = new Float32Array(request.queryVector);
    const results: VectorSearchMatch<TMetadata>[] = [];

    for (const entry of ns.activeEntries) {
      const startByte = entry.offset * 4;
      const endByte = startByte + entry.dimensions * 4;
      if (endByte > ns.vectorBuffer.byteLength) continue;

      const entryBuf = ns.vectorBuffer.subarray(startByte, endByte);
      const entryVec = new Float32Array(
        entryBuf.buffer,
        entryBuf.byteOffset,
        entry.dimensions,
      );

      const score = cosineSimilarity(queryVec, entryVec);
      if (request.threshold !== undefined && score < request.threshold) continue;

      const metadata = (ns.metadataMap.get(entry.id) ?? {}) as TMetadata;
      results.push({ id: entry.id, score, metadata });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, request.topK);
  }

  async upsert<TMetadata extends Readonly<Record<string, unknown>>>(
    _records: readonly VectorRecord<TMetadata>[],
  ): Promise<void> {
    throw new Error('CachedFileVectorIndex is read-only');
  }

  async deleteByDocument(_corpusId: string, _documentId: string): Promise<void> {
    throw new Error('CachedFileVectorIndex is read-only');
  }

  /** Explicitly clear all cached namespaces. */
  invalidate(): void {
    this.nsCache.clear();
  }

  /** Get stats about loaded namespaces for diagnostics. */
  getStats(): { namespace: string; vectors: number; memoryMB: number }[] {
    const stats: { namespace: string; vectors: number; memoryMB: number }[] = [];
    for (const [key, ns] of this.nsCache) {
      if (!ns) continue;
      stats.push({
        namespace: key,
        vectors: ns.activeEntries.length,
        memoryMB: ns.vectorBuffer
          ? ns.vectorBuffer.byteLength / 1024 / 1024
          : 0,
      });
    }
    return stats;
  }
}
