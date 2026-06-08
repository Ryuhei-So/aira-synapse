import { describe, it, expect, vi } from 'vitest';
import type { IThesaurus, ThesaurusRelation } from '../../../../src/domain/dictionary/index.js';
import { createNotImplementedStub } from '../../../setup/testDoubles.js';
import { ThesaurusExpansionPolicy } from '../../../../src/application/query/ThesaurusExpansionPolicy.js';

function relation(overrides: Partial<ThesaurusRelation>): ThesaurusRelation {
  return {
    relationId: 'rel-1',
    sourceTerm: 'gnn',
    targetTerm: 'graph neural network',
    relationType: 'synonym',
    language: 'en',
    weight: 0.9,
    bidirectional: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('TASK-MG-044: ThesaurusExpansionPolicy', () => {
  it('expands queries with synonym and hypernym limits', async () => {
    const thesaurus = {
      ...createNotImplementedStub<IThesaurus>('IThesaurus'),
      getRelations: vi.fn<IThesaurus['getRelations']>().mockResolvedValue([
        relation({ relationId: 'syn-1', relationType: 'synonym', targetTerm: 'graph neural network' }),
        relation({ relationId: 'syn-2', relationType: 'synonym', targetTerm: 'graph conv net' }),
        relation({ relationId: 'hyp-1', relationType: 'hypernym', targetTerm: 'neural model', bidirectional: false }),
      ]),
    } satisfies IThesaurus;

    const policy = new ThesaurusExpansionPolicy(thesaurus, { synonymLimit: 1, hypernymLimit: 1 });
    const expansion = await policy.expandQuery('gnn');

    expect(expansion.expandedTerms).toEqual(['graph neural network', 'neural model']);
    expect(expansion.rewrittenQuery).toBe('gnn graph neural network neural model');
  });

  it('deduplicates repeated related terms across tokens', async () => {
    const thesaurus = {
      ...createNotImplementedStub<IThesaurus>('IThesaurus'),
      getRelations: vi.fn<IThesaurus['getRelations']>().mockResolvedValue([
        relation({ targetTerm: 'graph neural network' }),
        relation({ relationId: 'syn-2', sourceTerm: 'citation', targetTerm: 'graph neural network' }),
      ]),
    } satisfies IThesaurus;

    const policy = new ThesaurusExpansionPolicy(thesaurus);
    const expansion = await policy.expandQuery('gnn citation');
    expect(expansion.expandedTerms).toEqual(['graph neural network']);
  });

  it('returns the original query when no relations are found', async () => {
    const thesaurus = {
      ...createNotImplementedStub<IThesaurus>('IThesaurus'),
      getRelations: vi.fn<IThesaurus['getRelations']>().mockResolvedValue([]),
    } satisfies IThesaurus;

    const policy = new ThesaurusExpansionPolicy(thesaurus);
    const expansion = await policy.expandQuery('plain query');
    expect(expansion).toEqual({ originalQuery: 'plain query', expandedTerms: [], rewrittenQuery: 'plain query' });
  });
});
