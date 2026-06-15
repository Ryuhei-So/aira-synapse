/**
 * Contract test suite for IGraphProjection implementations.
 */

import { it, expect, beforeEach, afterEach } from 'vitest';
import type { IGraphProjection, TransitionEntry } from '../../src/domain/retrieval/ppr.js';

const CORPUS = 'corpus-1';

export interface GraphProjectionFactory {
  create(): Promise<IGraphProjection>;
  teardown(): Promise<void>;
  /** Seed graph data (nodes + edges) into the backing store before testing. */
  seedGraph(corpusId: string): Promise<void>;
}

async function collectAll(iter: AsyncIterable<TransitionEntry>): Promise<TransitionEntry[]> {
  const entries: TransitionEntry[] = [];
  for await (const e of iter) entries.push(e);
  return entries;
}

export function graphProjectionContractTests(factory: GraphProjectionFactory): void {
  let projection: IGraphProjection;

  beforeEach(async () => {
    projection = await factory.create();
    await factory.seedGraph(CORPUS);
  });
  afterEach(async () => { await factory.teardown(); });

  it('returns transition entries for edges in corpus', async () => {
    const entries = await collectAll(projection.getTransitions(CORPUS));
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.sourceNodeId).toBeTruthy();
      expect(e.targetNodeId).toBeTruthy();
      expect(typeof e.weight).toBe('number');
    }
  });

  it('excludes entity layer nodes from transitions', async () => {
    const entries = await collectAll(projection.getTransitions(CORPUS));
    for (const e of entries) {
      expect(e.sourceNodeId).not.toMatch(/^entity:/);
      expect(e.targetNodeId).not.toMatch(/^entity:/);
    }
  });

  it('returns dangling nodes (leaf nodes)', async () => {
    const dangling = await projection.getDanglingNodes(CORPUS);
    expect(Array.isArray(dangling)).toBe(true);
  });

  it('returns node count for corpus', async () => {
    const count = await projection.getNodeCount(CORPUS);
    expect(count).toBeGreaterThan(0);
  });

  it('returns empty for unknown corpus', async () => {
    const entries = await collectAll(projection.getTransitions('nonexistent'));
    expect(entries).toHaveLength(0);

    const count = await projection.getNodeCount('nonexistent');
    expect(count).toBe(0);
  });
}
