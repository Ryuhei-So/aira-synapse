/**
 * Paged ranking-graph read (literature-hub #594).
 *
 * The whole-corpus `projection_get_transitions` reply outgrew the owner's
 * line bound (3,018,499 entries, about 702 MB at generation 1279). aira-graphdb
 * serves the same entries through `projection_get_transitions_page`: a total
 * order cut into pages under `limits.projectionRead.maxResponseBytes`, pinned
 * to one committed generation. This module feature-detects that method from
 * `protocol_info` and validates every page before its entries reach the
 * caller, so a read that is inconsistent in any way fails closed and the
 * cached projection keeps serving (see CachedGraphProjection).
 */
import type { TransitionEntry } from '../../../domain/retrieval/ppr.js';
import type { AiraGraphDbRpcClient, NativeRequestLimits } from './NativeClient.js';

type JsonObject = Record<string, unknown>;

export const PROJECTION_PAGE_METHOD = 'projection_get_transitions_page';
export const PROJECTION_READ_SCHEMA = 'native-projection-read@1';
export const PROJECTION_READ_ORDER = 'source-target-key@1';

/** Wire caps of one page request, taken from the native's advertisement. */
export interface ProjectionReadCapabilities {
  readonly wire: NativeRequestLimits;
}

/** A page reply that contradicts the page protocol. */
export class ProjectionPageError extends Error {
  public readonly code: 'PROJECTION_PAGE_INVALID' | 'PROJECTION_GENERATION_CHANGED';

  public constructor(code: ProjectionPageError['code'], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProjectionPageError';
    this.code = code;
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function requirePositiveSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value as number;
}

/**
 * Returns null when the native does not advertise the page method (a binary
 * before the #594 native PR): the caller keeps the single-reply read. A
 * native that advertises the method with a wrong classification or without a
 * valid `limits.projectionRead` is rejected: that is a broken contract, not
 * an older binary, and silently reverting to the O(corpus) reply would hide it.
 */
export function parseProjectionReadCapabilities(protocol: unknown): ProjectionReadCapabilities | null {
  if (!isObject(protocol) || !Array.isArray(protocol.methods)) {
    throw new Error('protocol_info.methods must be an array');
  }
  const method = protocol.methods.find(
    (candidate): candidate is JsonObject => isObject(candidate) && candidate.name === PROJECTION_PAGE_METHOD,
  );
  if (!method) return null;
  if (method.classification !== 'read' || method.wal !== false) {
    throw new Error(`aira-graphdb method contract mismatch for ${PROJECTION_PAGE_METHOD}: expected classification read, wal false`);
  }
  const limits = isObject(protocol.limits) ? protocol.limits : null;
  const read = limits && isObject(limits.projectionRead) ? limits.projectionRead : null;
  if (!read) {
    throw new Error(`aira-graphdb advertises ${PROJECTION_PAGE_METHOD} without protocol_info.limits.projectionRead`);
  }
  if (read.schema !== PROJECTION_READ_SCHEMA) {
    throw new Error(`unsupported protocol_info.limits.projectionRead.schema: ${String(read.schema)}`);
  }
  if (read.order !== PROJECTION_READ_ORDER) {
    throw new Error(`unsupported protocol_info.limits.projectionRead.order: ${String(read.order)}`);
  }
  const maxResponseBytes = requirePositiveSafeInteger(
    read.maxResponseBytes,
    'protocol_info.limits.projectionRead.maxResponseBytes',
  );
  const indexing = limits && isObject(limits.indexingMemory) ? limits.indexingMemory : null;
  const maxRequestBytes = requirePositiveSafeInteger(
    indexing?.maxRequestBytes,
    'protocol_info.limits.indexingMemory.maxRequestBytes',
  );
  return Object.freeze({ wire: Object.freeze({ maxRequestBytes, maxResponseBytes }) });
}

const PROTOCOL_INFO_LIMITS: NativeRequestLimits = {
  maxRequestBytes: 1024 * 1024,
  maxResponseBytes: 1024 * 1024,
};

/** Reads `protocol_info` once and parses the paged-read capability (null when absent). */
export async function detectProjectionRead(client: AiraGraphDbRpcClient): Promise<ProjectionReadCapabilities | null> {
  return parseProjectionReadCapabilities(await client.request<unknown>('protocol_info', {}, PROTOCOL_INFO_LIMITS));
}

function invalid(message: string): ProjectionPageError {
  return new ProjectionPageError('PROJECTION_PAGE_INVALID', `projection page ${message}`);
}

function validateEntry(value: unknown): TransitionEntry {
  if (!isObject(value)
    || typeof value.sourceNodeId !== 'string'
    || typeof value.targetNodeId !== 'string'
    || typeof value.weight !== 'number'
    || !Number.isFinite(value.weight)) {
    throw invalid('entry must be {sourceNodeId, targetNodeId, weight}');
  }
  return value as unknown as TransitionEntry;
}

interface PageCursor {
  /** Pinned generation; null only for the first page. */
  readonly generation: number | null;
  readonly offset: number;
  /** totalEntries of the first page; null only for the first page. */
  readonly total: number | null;
}

interface ValidatedPage {
  readonly generation: number;
  readonly total: number;
  readonly entries: readonly TransitionEntry[];
  readonly nextOffset: number | null;
}

/** Checks one page against the cursor that requested it. Exported for tests. */
export function validateProjectionPage(reply: unknown, cursor: PageCursor): ValidatedPage {
  if (!isObject(reply)) throw invalid('reply must be an object');
  const { generation, offset, nextOffset, totalEntries, entries } = reply;
  if (!isNonnegativeSafeInteger(generation)) throw invalid('generation must be a nonnegative safe integer');
  if (cursor.generation !== null && generation !== cursor.generation) {
    throw invalid(`generation ${generation} differs from the pinned generation ${cursor.generation}`);
  }
  if (offset !== cursor.offset) throw invalid(`offset ${String(offset)} differs from the requested ${cursor.offset}`);
  if (!isNonnegativeSafeInteger(totalEntries)) throw invalid('totalEntries must be a nonnegative safe integer');
  if (cursor.total !== null && totalEntries !== cursor.total) {
    throw invalid(`totalEntries changed from ${cursor.total} to ${totalEntries}`);
  }
  if (!Array.isArray(entries)) throw invalid('entries must be an array');
  if (entries.length === 0 && totalEntries !== 0) throw invalid('is empty before the end of the projection');
  const end = cursor.offset + entries.length;
  if (end > totalEntries) throw invalid('delivers more entries than totalEntries');
  if (nextOffset === null) {
    if (end !== totalEntries) throw invalid(`ends at ${end} of ${totalEntries} entries`);
  } else if (nextOffset !== end) {
    throw invalid(`nextOffset ${String(nextOffset)} does not follow offset ${cursor.offset} + ${entries.length}`);
  }
  return {
    generation,
    total: totalEntries,
    entries: entries.map(validateEntry),
    nextOffset: nextOffset as number | null,
  };
}

/**
 * Streams the corpus transitions page by page. Entries of one page are
 * yielded before the next page is requested, so the reader never holds more
 * than one page reply besides what the consumer keeps (review M2 of #594:
 * the reload peak is the new array plus one page, not the whole reply line).
 * The first page names the generation and every later page pins it; when a
 * later page is rejected and the store generation has moved, the failure is
 * reported as PROJECTION_GENERATION_CHANGED.
 */
export async function* readProjectionPages(
  client: AiraGraphDbRpcClient,
  capabilities: ProjectionReadCapabilities,
  corpusId: string,
  readGeneration: () => Promise<number>,
): AsyncIterable<TransitionEntry> {
  let cursor: PageCursor = { generation: null, offset: 0, total: null };
  for (;;) {
    let reply: unknown;
    try {
      reply = await client.request<unknown>(
        PROJECTION_PAGE_METHOD,
        { corpusId, generation: cursor.generation, offset: cursor.offset },
        capabilities.wire,
      );
    } catch (error) {
      if (cursor.generation !== null) {
        const current = await readGeneration().catch(() => cursor.generation);
        if (current !== cursor.generation) {
          throw new ProjectionPageError(
            'PROJECTION_GENERATION_CHANGED',
            `store generation moved from ${cursor.generation} to ${String(current)} during a paged projection read`,
            { cause: error },
          );
        }
      }
      throw error;
    }
    const page = validateProjectionPage(reply, cursor);
    yield* page.entries;
    if (page.nextOffset === null) return;
    cursor = { generation: page.generation, offset: page.nextOffset, total: page.total };
  }
}
