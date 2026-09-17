/**
 * Shared id handling for query classes that resolve vector/PPR node ids to
 * stored memory objects through IMemoryReader.
 *
 * The legacy snapshot lookups were `map.get(stripped) ?? map.get(nodeId)`;
 * both candidates are requested so the resolution stays identical.
 */

export function stripNodePrefix(nodeId: string, prefix: string): string {
  return nodeId.startsWith(prefix) ? nodeId.slice(prefix.length) : nodeId;
}

/** Every id a `stripped ?? raw` lookup may touch, deduplicated, in first-seen order. */
export function lookupIds(nodeIds: Iterable<string>, prefix: string): string[] {
  const ids = new Set<string>();
  for (const nodeId of nodeIds) {
    ids.add(stripNodePrefix(nodeId, prefix));
    ids.add(nodeId);
  }
  return [...ids];
}

export function indexById<T>(items: readonly T[], idOf: (item: T) => string): Map<string, T> {
  return new Map(items.map((item) => [idOf(item), item]));
}

export function resolveNode<T>(byId: Map<string, T>, nodeId: string, prefix: string): T | undefined {
  return byId.get(stripNodePrefix(nodeId, prefix)) ?? byId.get(nodeId);
}
