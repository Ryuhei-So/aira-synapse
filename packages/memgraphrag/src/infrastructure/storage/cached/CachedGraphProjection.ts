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

export interface ProjectionCacheEvent {
  readonly event: 'graph_projection_cache_loaded' | 'graph_projection_cache_invalidated';
  readonly corpusId: string | null;
  readonly entries: number;
  /** Estimated resident bytes of the cached entries (string chars x2 + object overhead). */
  readonly estimatedBytes: number;
  readonly version?: unknown;
}

const ENTRY_OBJECT_OVERHEAD_BYTES = 56;

function estimateEntryBytes(entries: readonly TransitionEntry[]): number {
  let bytes = 0;
  for (const entry of entries) {
    bytes += ENTRY_OBJECT_OVERHEAD_BYTES + (entry.sourceNodeId.length + entry.targetNodeId.length) * 2;
  }
  return bytes;
}

export class CachedGraphProjection implements IGraphProjection {
  private readonly inner: IGraphProjection;
  private readonly onEvent: (event: ProjectionCacheEvent) => void;
  private cache: { corpusId: string; entries: TransitionEntry[] } | null = null;
  private loadPromise: Promise<{ corpusId: string; entries: TransitionEntry[] }> | null = null;
  private version: unknown = undefined;
  private versionSeen = false;
  /** Bumped by every invalidation; a load only publishes if its epoch is still current. */
  private epoch = 0;

  constructor(inner: IGraphProjection, options: { onEvent?: (event: ProjectionCacheEvent) => void } = {}) {
    this.inner = inner;
    this.onEvent = options.onEvent ?? (() => undefined);
  }

  /**
   * Invariant: an invalidation during an in-flight load wins. The load still
   * completes for the caller that started it, but its result is not
   * published as the cache, so the next call reloads. Callers are expected to
   * serialise queries (the bridge does); concurrent loads for different
   * corpora share one load slot and simply wait.
   */
  private async ensureCache(corpusId: string): Promise<readonly TransitionEntry[]> {
    if (this.cache && this.cache.corpusId === corpusId) return this.cache.entries;
    if (this.loadPromise) {
      const shared = await this.loadPromise;
      if (shared.corpusId === corpusId) return shared.entries;
    }

    const epoch = this.epoch;
    const load = (async () => {
      const entries: TransitionEntry[] = [];
      for await (const entry of this.inner.getTransitions(corpusId)) {
        entries.push(entry);
      }
      if (epoch === this.epoch) {
        this.cache = { corpusId, entries };
        this.onEvent({
          event: 'graph_projection_cache_loaded',
          corpusId,
          entries: entries.length,
          estimatedBytes: estimateEntryBytes(entries),
          version: this.version,
        });
      }
      return { corpusId, entries };
    })();
    this.loadPromise = load;

    try {
      return (await load).entries;
    } finally {
      if (this.loadPromise === load) this.loadPromise = null;
    }
  }

  /**
   * The cached entries array itself. Its identity changes only when the cache
   * is invalidated and reloaded, which is exactly when anything derived from
   * the transitions (a compiled PPR graph) must be rebuilt.
   */
  async getTransitionSnapshot(corpusId: string): Promise<readonly TransitionEntry[]> {
    return this.ensureCache(corpusId);
  }

  async *getTransitions(corpusId: string): AsyncIterable<TransitionEntry> {
    // Iterate the entries this call loaded or found, not `this.cache`: an
    // invalidation may have unpublished them meanwhile (see ensureCache).
    const entries = await this.ensureCache(corpusId);
    for (const entry of entries) {
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
    this.epoch += 1;
    const dropped = this.cache;
    this.cache = null;
    this.onEvent({
      event: 'graph_projection_cache_invalidated',
      corpusId: dropped?.corpusId ?? null,
      entries: dropped?.entries.length ?? 0,
      estimatedBytes: dropped ? estimateEntryBytes(dropped.entries) : 0,
      version: this.version,
    });
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
