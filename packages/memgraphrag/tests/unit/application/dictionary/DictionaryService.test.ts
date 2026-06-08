import { describe, it, expect, vi } from 'vitest';
import type { ITermDictionary, TermDictionaryEntry, DictionaryStatistics } from '../../../../src/domain/dictionary/index.js';
import { createNotImplementedStub } from '../../../setup/testDoubles.js';
import { DefaultDictionaryService } from '../../../../src/application/dictionary/DictionaryService.js';

const now = '2026-01-01T00:00:00.000Z';

function createEntry(overrides: Partial<TermDictionaryEntry> = {}): TermDictionaryEntry {
  return {
    termId: 'term-1',
    term: 'Graph Neural Network',
    canonicalForm: 'graph neural network',
    domainCategory: 'ml',
    aliases: ['GNN'],
    frequency: 3,
    confidence: 0.9,
    source: 'manual',
    version: '1',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('TASK-MG-041: DefaultDictionaryService', () => {
  it('dispatches add to upsertEntries', async () => {
    const upsertEntries = vi.fn<ITermDictionary['upsertEntries']>().mockResolvedValue();
    const dictionary = {
      ...createNotImplementedStub<ITermDictionary>('ITermDictionary'),
      upsertEntries,
    } satisfies ITermDictionary;

    const service = new DefaultDictionaryService(dictionary);
    const entry = createEntry();

    const result = await service.handle({ corpusId: 'corpus-1', action: 'add', entry });

    expect(result).toEqual({ action: 'add', entries: [entry] });
    expect(upsertEntries).toHaveBeenCalledWith([entry]);
  });

  it('dispatches search to match and returns matched entries only', async () => {
    const entry = createEntry();
    const match = vi.fn<ITermDictionary['match']>().mockResolvedValue([
      { entry, matchedText: 'GNN', boostFactor: 1.8 },
    ]);
    const dictionary = {
      ...createNotImplementedStub<ITermDictionary>('ITermDictionary'),
      match,
    } satisfies ITermDictionary;

    const service = new DefaultDictionaryService(dictionary, 'en');
    const result = await service.handle({ corpusId: 'corpus-1', action: 'search', query: 'GNN methods' });

    expect(match).toHaveBeenCalledWith('GNN methods', 'en');
    expect(result).toEqual({ action: 'search', entries: [entry] });
  });

  it('dispatches stats to getStatistics', async () => {
    const statistics: DictionaryStatistics = {
      totalTerms: 2,
      domains: { biology: 1, ml: 1 },
      boostAppliedRate: 0.5,
      discoveredTermCount: 3,
    };
    const getStatistics = vi.fn<ITermDictionary['getStatistics']>().mockResolvedValue(statistics);
    const dictionary = {
      ...createNotImplementedStub<ITermDictionary>('ITermDictionary'),
      getStatistics,
    } satisfies ITermDictionary;

    const service = new DefaultDictionaryService(dictionary);
    const result = await service.handle({ corpusId: 'corpus-1', action: 'stats' });

    expect(result).toEqual({ action: 'stats', statistics });
  });

  it('dispatches import and export as JSON payloads', async () => {
    const importJson = vi.fn<ITermDictionary['importJson']>().mockResolvedValue();
    const exportJson = vi.fn<ITermDictionary['exportJson']>().mockResolvedValue({
      corpusId: 'corpus-1',
      termDictionary: [createEntry()],
    });
    const dictionary = {
      ...createNotImplementedStub<ITermDictionary>('ITermDictionary'),
      importJson,
      exportJson,
    } satisfies ITermDictionary;

    const service = new DefaultDictionaryService(dictionary);
    const importPayload = [createEntry({ termId: 'term-2', term: 'Protein Folding' })];

    const imported = await service.handle({ corpusId: 'corpus-1', action: 'import', data: importPayload });
    const exported = await service.handle({ corpusId: 'corpus-1', action: 'export' });

    expect(importJson).toHaveBeenCalledWith({ corpusId: 'corpus-1', termDictionary: importPayload });
    expect(imported).toEqual({ action: 'import', entries: importPayload });
    expect(exported.action).toBe('export');
    expect(exported.exportData).toEqual({ corpusId: 'corpus-1', termDictionary: [createEntry()] });
  });

  it('rejects missing action payloads', async () => {
    const dictionary = createNotImplementedStub<ITermDictionary>('ITermDictionary');
    const service = new DefaultDictionaryService(dictionary);

    await expect(service.handle({ corpusId: 'corpus-1', action: 'add' })).rejects.toThrow('entry is required');
    await expect(service.handle({ corpusId: 'corpus-1', action: 'search' })).rejects.toThrow('query is required');
  });
});
