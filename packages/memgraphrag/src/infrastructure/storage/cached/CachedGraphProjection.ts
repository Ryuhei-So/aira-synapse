/**
 * CachedGraphProjection — Loads all transition entries into memory once
 * and serves subsequent PPR calls from the cache.
 *
 * LadybugDB Cypher (and even SQLite at 448K edges) is too slow to reload
 * the full adjacency list per query. This wrapper trades ~50MB RAM for
 * sub-millisecond iteration on repeated PPR runs.
 */
import type { IGraphProjection, TransitionEntry } from '../../../domain/retrieval/ppr.js';

export class CachedGraphProjection implements IGraphProjection {
  private readonly inner: IGraphProjection;
  private cache: { corpusId: string; entries: TransitionEntry[] } | null = null;
  private loadPromise: Promise<void> | null = null;

  constructor(inner: IGraphProjection) {
    this.inner = inner;
  }

  private async ensureCache(corpusId: string): Promise<void> {
    if (this.cache && this.cache.corpusId === corpusId) return;
    if (this.loadPromise) {
      await this.loadPromise;
      return;
    }

    this.loadPromise = (async () => {
      const entries: TransitionEntry[] = [];
      for await (const entry of this.inner.getTransitions(corpusId)) {
        entries.push(entry);
      }
      this.cache = { corpusId, entries };
    })();

    await this.loadPromise;
    this.loadPromise = null;
  }

  async *getTransitions(corpusId: string): AsyncIterable<TransitionEntry> {
    await this.ensureCache(corpusId);
    for (const entry of this.cache!.entries) {
      yield entry;
    }
  }

  async getDanglingNodes(corpusId: string): Promise<readonly string[]> {
    return this.inner.getDanglingNodes(corpusId);
  }

  async getNodeCount(corpusId: string): Promise<number> {
    return this.inner.getNodeCount(corpusId);
  }

  /** Explicitly clear the cache. */
  invalidate(): void {
    this.cache = null;
  }
}
