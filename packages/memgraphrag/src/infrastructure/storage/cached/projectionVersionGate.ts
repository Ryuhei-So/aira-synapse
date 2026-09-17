import type { IGraphProjection } from '../../../domain/retrieval/ppr.js';
import { CachedGraphProjection } from './CachedGraphProjection.js';

/** Reads the store's committed generation (aira-graphdb: `protocol_info.generation`). */
export type StoreGenerationSource = () => Promise<number>;

/**
 * Query-entry gate for the cached ranking graph (literature-hub #545 review
 * M1): observe the generation the backend reports and drop the cached
 * projection the first time it differs, so a long-lived reader never ranks
 * on a graph superseded by re-indexing. Returns true when the cache was
 * invalidated. A projection that is not cached, or a backend without a
 * generation signal, is a no-op.
 */
export async function syncProjectionVersion(
  projection: IGraphProjection,
  readGeneration: StoreGenerationSource | undefined,
): Promise<boolean> {
  if (!readGeneration || !(projection instanceof CachedGraphProjection)) return false;
  const generation = await readGeneration();
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error('store generation must be a nonnegative safe integer');
  }
  return projection.invalidateIfVersionChanged(generation);
}
