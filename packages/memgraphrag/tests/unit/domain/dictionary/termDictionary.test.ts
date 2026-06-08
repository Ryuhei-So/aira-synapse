import { describe, expect, it } from 'vitest';
import type {
  DictionarySource,
  ITermDictionary,
} from '../../../../src/domain/dictionary/termDictionary.js';
import { createNotImplementedStub } from '../../../setup/testDoubles.js';

describe('TASK-MG-013: term dictionary contracts', () => {
  it('allows ITermDictionary to be typed via createNotImplementedStub', () => {
    const dictionary = createNotImplementedStub<ITermDictionary>('ITermDictionary');

    expect(() => dictionary.match('TP53', 'en')).toThrow(
      'ITermDictionary.match() should not be called in this test',
    );
  });

  it('supports every DictionarySource union member', () => {
    const sources: DictionarySource[] = [
      'api',
      'manual',
      'extracted',
      'approved_candidate',
    ];

    expect(sources).toEqual([
      'api',
      'manual',
      'extracted',
      'approved_candidate',
    ]);
  });
});
