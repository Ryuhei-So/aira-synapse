/**
 * CachedGraphProjection — Loads all transition entries into memory once
 * and serves subsequent PPR calls from the cache.
 *
 * Reloading the full adjacency list per query is too slow for every backend
 * (LadybugDB Cypher, SQLite at 448K edges, and aira-graphdb at 2.15M edges,
 * whose single-line reply is several hundred megabytes; see literature-hub
 * #471). The cache is keyed by corpus and, when the host process knows the
 * store's generation, by that version: `invalidateIfVersionChanged` drops
 * the cache the first time a different version is observed so a reader
 * never ranks on a superseded graph.
 */
import type { IGraphProjection, TransitionEntry } from '../../../domain/retrieval/ppr.js';

export class CachedGraphProjection implements IGraphProjection {
  private readonly inner: IGraphProjection;
  private cache: { corpusId: string; entries: TransitionEntry[] } | null = null;
  private loadPromise: Promise<void> | null = null;
  private version: unknown = undefined;
  private versionSeen = false;

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

  /**
   * Records the store version the host observed (for example a generation
   * number) and invalidates the cache when it differs from the last one.
   * Returns true when an invalidation happened. The first observation only
   * records the version. A load in flight when the version changes is still
   * awaited by its caller but is discarded for subsequent callers.
   */
  invalidateIfVersionChanged(version: unknown): boolean {
    const changed = this.versionSeen && !Object.is(this.version, version);
    this.version = version;
    this.versionSeen = true;
    if (changed) this.invalidate();
    return changed;
  }

  /** The last version passed to invalidateIfVersionChanged, if any. */
  get observedVersion(): unknown {
    return this.version;
  }
}
