import { describe, it, expect, vi } from 'vitest';
import type { IThesaurus, NormalizationResult, ThesaurusRelation } from '../../../../src/domain/dictionary/index.js';
import { createNotImplementedStub } from '../../../setup/testDoubles.js';
import { DefaultThesaurusService, ThesaurusValidator } from '../../../../src/application/thesaurus/ThesaurusService.js';

const now = '2026-01-01T00:00:00.000Z';

function createRelation(overrides: Partial<ThesaurusRelation> = {}): ThesaurusRelation {
  return {
    relationId: 'rel-1',
    sourceTerm: 'carcinoma',
    targetTerm: 'cancer',
    relationType: 'synonym',
    language: 'en',
    weight: 0.9,
    bidirectional: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('TASK-MG-042: DefaultThesaurusService', () => {
  it('adds a relation by re-importing merged export data', async () => {
    const relation = createRelation();
    const exportJson = vi.fn<IThesaurus['exportJson']>().mockResolvedValue({ thesaurusRelations: [] });
    const importJson = vi.fn<IThesaurus['importJson']>().mockResolvedValue();
    const thesaurus = {
      ...createNotImplementedStub<IThesaurus>('IThesaurus'),
      exportJson,
      importJson,
    } satisfies IThesaurus;

    const service = new DefaultThesaurusService(thesaurus);
    const result = await service.handle({ corpusId: 'corpus-1', action: 'add', relation });

    expect(importJson).toHaveBeenCalledWith({ corpusId: 'corpus-1', thesaurusRelations: [relation] });
    expect(result).toEqual({ action: 'add', relations: [relation] });
  });

  it('looks up relations and normalization result', async () => {
    const normalization: NormalizationResult = {
      canonicalTerm: 'cancer',
      originalTerm: 'carcinoma',
      appliedRelations: [createRelation()],
    };
    const getRelations = vi.fn<IThesaurus['getRelations']>().mockResolvedValue([createRelation()]);
    const normalize = vi.fn<IThesaurus['normalize']>().mockResolvedValue(normalization);
    const thesaurus = {
      ...createNotImplementedStub<IThesaurus>('IThesaurus'),
      getRelations,
      normalize,
    } satisfies IThesaurus;

    const service = new DefaultThesaurusService(thesaurus, new ThesaurusValidator(), 'en');
    const result = await service.handle({ corpusId: 'corpus-1', action: 'lookup', term: 'carcinoma' });

    expect(result.relations).toHaveLength(1);
    expect(result.normalization).toEqual(normalization);
    expect(normalize).toHaveBeenCalledWith('carcinoma', 'en');
  });

  it('derives statistics from exported relations', async () => {
    const exportJson = vi.fn<IThesaurus['exportJson']>().mockResolvedValue({
      thesaurusRelations: [
        createRelation({ relationType: 'synonym' }),
        createRelation({ relationId: 'rel-2', relationType: 'hypernym', bidirectional: false }),
      ],
    });
    const thesaurus = {
      ...createNotImplementedStub<IThesaurus>('IThesaurus'),
      exportJson,
    } satisfies IThesaurus;

    const service = new DefaultThesaurusService(thesaurus);
    const result = await service.handle({ corpusId: 'corpus-1', action: 'stats' });

    expect(result.statistics).toEqual({
      totalRelations: 2,
      byType: { synonym: 1, hypernym: 1 },
      bidirectionalCount: 1,
    });
  });

  it('validates import payloads for hypernym cycles', async () => {
    const importJson = vi.fn<IThesaurus['importJson']>().mockResolvedValue();
    const thesaurus = {
      ...createNotImplementedStub<IThesaurus>('IThesaurus'),
      importJson,
    } satisfies IThesaurus;
    const service = new DefaultThesaurusService(thesaurus);

    await expect(service.handle({
      corpusId: 'corpus-1',
      action: 'import',
      data: [
        createRelation({ relationId: 'rel-a', sourceTerm: 'a', targetTerm: 'b', relationType: 'hypernym', bidirectional: false }),
        createRelation({ relationId: 'rel-b', sourceTerm: 'b', targetTerm: 'a', relationType: 'hypernym', bidirectional: false }),
      ],
    })).rejects.toThrow('cycle');

    expect(importJson).not.toHaveBeenCalled();
  });

  it('exports the raw thesaurus payload and rejects missing term payloads', async () => {
    const exportJson = vi.fn<IThesaurus['exportJson']>().mockResolvedValue({ thesaurusRelations: [createRelation()] });
    const thesaurus = {
      ...createNotImplementedStub<IThesaurus>('IThesaurus'),
      exportJson,
    } satisfies IThesaurus;

    const service = new DefaultThesaurusService(thesaurus);
    const exported = await service.handle({ corpusId: 'corpus-1', action: 'export' });

    expect(exported.exportData).toEqual({ thesaurusRelations: [createRelation()] });
    await expect(service.handle({ corpusId: 'corpus-1', action: 'lookup' })).rejects.toThrow('term is required');
  });
});
