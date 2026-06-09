import { describe, expect, it } from 'vitest';
import { MemorySampler } from '../../src/infrastructure/logging/MemorySampler.js';

describe.skip('TASK-MG-051 benchmark: memory rss budget', () => {
  it('keeps rss under budget for lightweight graph allocations', () => {
    const sampler = new MemorySampler();
    const graph = Array.from({ length: 5_000 }, (_, index) => ({ id: index, edges: [index + 1, index + 2, index + 3] }));

    expect(graph).toHaveLength(5_000);
    expect(sampler.assertBudget(256)).toBeGreaterThan(0);
  });
});
