/**
 * CachedMemoryStore — Decorator that caches the full MemorySnapshot in memory.
 *
 * SQLiteMemoryStore.load() reads 113K+ facts from disk on every call.
 * This wrapper loads once per corpus and serves subsequent calls from the cache,
 * eliminating repeated I/O during batch query workloads.
 */
import type { IMemoryStore, JobCheckpoint } from '../../../domain/storage/graphStore.js';
import type { MemorySnapshot } from '../../../domain/memory/globalMemory.js';

export class CachedMemoryStore implements IMemoryStore {
  private readonly inner: IMemoryStore;
  private cache: MemorySnapshot | null = null;
  private cachedCorpusId: string | null = null;
  private loadPromise: Promise<MemorySnapshot> | null = null;

  constructor(inner: IMemoryStore) {
    this.inner = inner;
  }

  async load(corpusId: string): Promise<MemorySnapshot> {
    if (this.cache && this.cachedCorpusId === corpusId) return this.cache;
    if (this.loadPromise) return this.loadPromise;

    this.loadPromise = (async () => {
      const snapshot = await this.inner.load(corpusId);
      this.cache = snapshot;
      this.cachedCorpusId = corpusId;
      this.loadPromise = null;
      return snapshot;
    })();

    return this.loadPromise;
  }

  /** Invalidate cache on write so next load() re-fetches. */
  async save(snapshot: MemorySnapshot): Promise<void> {
    await this.inner.save(snapshot);
    this.cache = null;
    this.cachedCorpusId = null;
  }

  async saveCheckpoint(checkpoint: JobCheckpoint): Promise<void> {
    return this.inner.saveCheckpoint(checkpoint);
  }

  async loadCheckpoint(jobId: string): Promise<JobCheckpoint | null> {
    return this.inner.loadCheckpoint(jobId);
  }

  async validateIntegrity(corpusId: string): Promise<readonly string[]> {
    return this.inner.validateIntegrity(corpusId);
  }

  /** Explicitly clear the cache. */
  invalidate(): void {
    this.cache = null;
    this.cachedCorpusId = null;
  }
}
