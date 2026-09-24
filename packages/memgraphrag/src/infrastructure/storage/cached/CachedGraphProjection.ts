/**
 * CachedGraphProjection — Loads all transition entries into memory once
 * and serves subsequent PPR calls from the cache.
 *
 * Reloading the full adjacency list per query is too slow for every backend
 * (LadybugDB Cypher, SQLite at 448K edges, and aira-graphdb at 2.15M edges,
 * whose single-line reply is several hundred megabytes; see literature-hub
 * #471). The cache is keyed by corpus and, when the host process knows the
 * store's generation, by that version: `invalidateIfVersionChanged` marks
 * the cache stale the first time a different version is observed and the
 * next call reloads it.
 *
 * Swap-on-success (literature-hub #594): a stale cache is replaced only by a
 * reload that succeeded. When the reload fails (for aira-graphdb, the owner's
 * NATIVE_LINE_OVERFLOW once the corpus reply outgrows its line bound), the
 * last successfully loaded projection keeps serving, a `projection_stale`
 * event records the served and current versions and the failure class, and
 * later calls retry the reload after a bounded exponential backoff. With no
 * loaded projection for the corpus, a failed load still fails the call.
 */
import type { IGraphProjection, TransitionEntry } from '../../../domain/retrieval/ppr.js';

export type ProjectionCacheEvent =
  | {
    readonly event: 'graph_projection_cache_loaded' | 'graph_projection_cache_invalidated';
    readonly corpusId: string | null;
    readonly entries: number;
    /** Estimated resident bytes of the cached entries (string chars x2 + object overhead). */
    readonly estimatedBytes: number;
    readonly version?: unknown;
  }
  | {
    readonly event: 'projection_stale';
    readonly corpusId: string;
    readonly entries: number;
    /** The version the served projection was loaded under. */
    readonly servedVersion: unknown;
    /** The version the host observed most recently. */
    readonly currentVersion: unknown;
    /** Error code of the last failed reload (never its message). */
    readonly failureClass: string;
    /** False when this call served stale inside the backoff window without retrying. */
    readonly reloadAttempted: boolean;
    readonly consecutiveFailures: number;
    readonly nextRetryInMs: number;
  };

export interface ProjectionReloadBackoff {
  /** Delay after the first failed reload. */
  readonly initialMs: number;
  /** Upper bound on the delay; it doubles per consecutive failure until here. */
  readonly maxMs: number;
}

export interface CachedGraphProjectionOptions {
  readonly onEvent?: (event: ProjectionCacheEvent) => void;
  readonly reloadBackoff?: ProjectionReloadBackoff;
  /** Clock for the backoff window; defaults to Date.now. */
  readonly now?: () => number;
}

/**
 * A failed reload reads (and the owner discards) up to its line bound, about
 * half a gigabyte for the production corpus, so retries are spaced out.
 */
export const DEFAULT_PROJECTION_RELOAD_BACKOFF: ProjectionReloadBackoff = { initialMs: 60_000, maxMs: 15 * 60_000 };

const ENTRY_OBJECT_OVERHEAD_BYTES = 56;
const FAILURE_CLASS_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

function estimateEntryBytes(entries: readonly TransitionEntry[]): number {
  let bytes = 0;
  for (const entry of entries) {
    bytes += ENTRY_OBJECT_OVERHEAD_BYTES + (entry.sourceNodeId.length + entry.targetNodeId.length) * 2;
  }
  return bytes;
}

/** The error's own code when it is a bounded constant-style token; messages are never logged. */
function failureClassOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && FAILURE_CLASS_PATTERN.test(code) ? code : 'UNCLASSIFIED';
}

interface CacheSlot {
  readonly corpusId: string;
  readonly entries: TransitionEntry[];
  /** The version observed when the load started. */
  readonly version: unknown;
  /** The version epoch the load started in; the slot is stale once it differs. */
  readonly epoch: number;
}

export class CachedGraphProjection implements IGraphProjection {
  private readonly inner: IGraphProjection;
  private readonly onEvent: (event: ProjectionCacheEvent) => void;
  private readonly backoff: ProjectionReloadBackoff;
  private readonly now: () => number;
  private cache: CacheSlot | null = null;
  private inflight: { corpusId: string; promise: Promise<TransitionEntry[]> } | null = null;
  private version: unknown = undefined;
  private versionSeen = false;
  /** Bumped by every version change; a cache slot from an older epoch is stale. */
  private epoch = 0;
  /** Bumped by every explicit invalidate(); a load that raced one is not published. */
  private clears = 0;
  private consecutiveFailures = 0;
  private retryAt = 0;
  private lastFailureClass = 'UNCLASSIFIED';

  constructor(inner: IGraphProjection, options: CachedGraphProjectionOptions = {}) {
    this.inner = inner;
    this.onEvent = options.onEvent ?? (() => undefined);
    this.backoff = options.reloadBackoff ?? DEFAULT_PROJECTION_RELOAD_BACKOFF;
    this.now = options.now ?? Date.now;
  }

  /**
   * Invariants:
   * - A fresh slot for the corpus is served as is.
   * - A stale slot is served when its reload fails or while the backoff
   *   window after a failed reload is open; it is only ever replaced by a
   *   successful load.
   * - With no slot for the corpus, a failed load rejects the call.
   * - A load that raced a version change is still published (it is newer than
   *   the slot it replaces) but stays stale, so the next call reloads.
   * Callers are expected to serialise queries (the bridge does); concurrent
   * calls share one load slot, and a call for another corpus waits for it.
   */
  private async ensureCache(corpusId: string): Promise<readonly TransitionEntry[]> {
    for (;;) {
      const slot = this.cache?.corpusId === corpusId ? this.cache : null;
      if (slot && slot.epoch === this.epoch) return slot.entries;
      if (this.inflight && this.inflight.corpusId !== corpusId) {
        await this.inflight.promise.catch(() => undefined);
        continue;
      }
      if (slot && !this.inflight && this.consecutiveFailures > 0 && this.now() < this.retryAt) {
        this.reportStale(slot, false);
        return slot.entries;
      }
      const flight = this.inflight ?? this.startLoad(corpusId);
      try {
        return await flight.promise;
      } catch (error) {
        const stale = this.cache?.corpusId === corpusId ? this.cache : null;
        if (stale) return stale.entries;
        throw error;
      }
    }
  }

  private startLoad(corpusId: string): { corpusId: string; promise: Promise<TransitionEntry[]> } {
    const flight = { corpusId, promise: this.load(corpusId, this.epoch, this.clears, this.version) };
    this.inflight = flight;
    // Registered before any caller awaits the promise, so the slot is free
    // again by the time a caller observes the outcome.
    flight.promise
      .finally(() => { if (this.inflight === flight) this.inflight = null; })
      .catch(() => undefined);
    return flight;
  }

  private async load(corpusId: string, epoch: number, clears: number, version: unknown): Promise<TransitionEntry[]> {
    try {
      const entries: TransitionEntry[] = [];
      for await (const entry of this.inner.getTransitions(corpusId)) {
        entries.push(entry);
      }
      if (clears === this.clears) {
        this.cache = { corpusId, entries, version, epoch };
        this.consecutiveFailures = 0;
        this.retryAt = 0;
        this.onEvent({
          event: 'graph_projection_cache_loaded',
          corpusId,
          entries: entries.length,
          estimatedBytes: estimateEntryBytes(entries),
          version,
        });
      }
      return entries;
    } catch (error) {
      const stale = this.cache?.corpusId === corpusId ? this.cache : null;
      if (stale) {
        this.consecutiveFailures += 1;
        const delay = Math.min(
          this.backoff.maxMs,
          this.backoff.initialMs * 2 ** Math.min(this.consecutiveFailures - 1, 30),
        );
        this.retryAt = this.now() + delay;
        this.lastFailureClass = failureClassOf(error);
        this.reportStale(stale, true);
      }
      throw error;
    }
  }

  private reportStale(slot: CacheSlot, reloadAttempted: boolean): void {
    this.onEvent({
      event: 'projection_stale',
      corpusId: slot.corpusId,
      entries: slot.entries.length,
      servedVersion: slot.version,
      currentVersion: this.version,
      failureClass: this.lastFailureClass,
      reloadAttempted,
      consecutiveFailures: this.consecutiveFailures,
      nextRetryInMs: Math.max(0, this.retryAt - this.now()),
    });
  }

  /**
   * The cached entries array itself. Its identity changes only when a reload
   * is published, which is exactly when anything derived from the
   * transitions (a compiled PPR graph) must be rebuilt.
   */
  async getTransitionSnapshot(corpusId: string): Promise<readonly TransitionEntry[]> {
    return this.ensureCache(corpusId);
  }

  async *getTransitions(corpusId: string): AsyncIterable<TransitionEntry> {
    // Iterate the entries this call loaded or found, not `this.cache`: a
    // later load may replace the slot meanwhile.
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

  /**
   * Explicitly clear the cache. Unlike a version change this drops the
   * served projection outright: the next call must load, and fails if that
   * load fails. A load in flight is not published.
   */
  invalidate(): void {
    this.epoch += 1;
    this.clears += 1;
    const dropped = this.cache;
    this.cache = null;
    this.consecutiveFailures = 0;
    this.retryAt = 0;
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
   * number) and marks the cache stale when it differs from the last one, so
   * the next call reloads; the stale projection keeps serving until a reload
   * succeeds. Returns true when the version changed. The first observation
   * only records the version.
   */
  invalidateIfVersionChanged(version: unknown): boolean {
    const changed = this.versionSeen && !Object.is(this.version, version);
    if (!this.versionSeen && this.cache) {
      // A projection loaded before any version was observed is adopted under it.
      this.cache = { ...this.cache, version };
    }
    this.version = version;
    this.versionSeen = true;
    if (changed) this.epoch += 1;
    return changed;
  }

  /** The last version passed to invalidateIfVersionChanged, if any. */
  get observedVersion(): unknown {
    return this.version;
  }

  /** The version the currently cached projection was loaded under, and whether it is stale. */
  get servedProjection(): { readonly corpusId: string; readonly version: unknown; readonly stale: boolean } | null {
    const slot = this.cache;
    return slot ? { corpusId: slot.corpusId, version: slot.version, stale: slot.epoch !== this.epoch } : null;
  }
}
