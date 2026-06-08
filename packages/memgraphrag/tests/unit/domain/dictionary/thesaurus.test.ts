import { describe, expect, it } from 'vitest';
import { isThesaurusRelationType } from '../../../../src/domain/dictionary/thesaurus.js';

describe('TASK-MG-014: thesaurus relation types', () => {
  it('accepts supported thesaurus relation types and rejects invalid values', () => {
    expect(isThesaurusRelationType('synonym')).toBe(true);
    expect(isThesaurusRelationType('hypernym')).toBe(true);
    expect(isThesaurusRelationType('hyponym')).toBe(true);
    expect(isThesaurusRelationType('related')).toBe(true);

    expect(isThesaurusRelationType('antonym')).toBe(false);
    expect(isThesaurusRelationType('')).toBe(false);
    expect(isThesaurusRelationType(null)).toBe(false);
  });
});
