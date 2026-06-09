import { describe, expect, it, vi } from 'vitest';
import type { ITermDictionary } from '../../../../src/domain/dictionary/index.js';
import { BuildDictionaryFromApi } from '../../../../src/application/dictionary/BuildDictionaryFromApi.js';
import { createNotImplementedStub } from '../../../setup/testDoubles.js';

describe('TASK-MG-045: BuildDictionaryFromApi', () => {
  it('extracts terms from papers and upserts api dictionary entries', async () => {
    const upsertEntries = vi.fn<ITermDictionary['upsertEntries']>().mockResolvedValue(undefined);
    const dictionary = {
      ...createNotImplementedStub<ITermDictionary>('ITermDictionary'),
      upsertEntries,
    } satisfies ITermDictionary;
    const client = {
      searchPapers: vi.fn().mockResolvedValue([
        {
          paperId: 'paper-1',
          title: 'Graph Neural Networks for Retrieval',
          abstract: 'Retrieval augmented generation uses graph neural networks for academic search.',
        },
        {
          paperId: 'paper-2',
          title: 'Knowledge Graph Retrieval in Science',
          abstract: 'Knowledge graph retrieval improves passage ranking.',
        },
      ]),
    };

    const builder = new BuildDictionaryFromApi(dictionary, client);
    const result = await builder.buildFromApi('corpus-1', ['biology'], 5);

    expect(result.termCount).toBeGreaterThan(0);
    expect(result.domainDistribution).toEqual({ biology: result.termCount });
    expect(upsertEntries).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ source: 'api', domainCategory: 'biology' }),
      ]),
    );
  });

  it('aggregates multiple domains independently', async () => {
    const upsertEntries = vi.fn<ITermDictionary['upsertEntries']>().mockResolvedValue(undefined);
    const dictionary = {
      ...createNotImplementedStub<ITermDictionary>('ITermDictionary'),
      upsertEntries,
    } satisfies ITermDictionary;
    const client = {
      searchPapers: vi.fn()
        .mockResolvedValueOnce([{ paperId: 'b1', title: 'Cell Signaling Networks', abstract: 'Cell signaling regulates tissue growth.' }])
        .mockResolvedValueOnce([{ paperId: 'm1', title: 'Transformer Retrieval Models', abstract: 'Transformer retrieval models rank passages.' }]),
    };

    const builder = new BuildDictionaryFromApi(dictionary, client);
    const result = await builder.buildFromApi('corpus-1', ['biology', 'ml'], 3);

    expect(client.searchPapers).toHaveBeenCalledTimes(2);
    expect(result.domainDistribution['biology']).toBeGreaterThan(0);
    expect(result.domainDistribution['ml']).toBeGreaterThan(0);
  });
});
