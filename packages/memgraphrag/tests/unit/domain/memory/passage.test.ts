import { describe, expect, it } from 'vitest';
import { hasValidOffsets } from '../../../../src/domain/memory/passage.js';
import type { DocumentMetadata } from '../../../../src/domain/memory/passage.js';

describe('TASK-MG-008: passage offset validation', () => {
  it('returns true when offsets are non-negative and end is greater than start', () => {
    expect(hasValidOffsets(makeMetadata(0, 10))).toBe(true);
    expect(hasValidOffsets(makeMetadata(5, 12))).toBe(true);
  });

  it('returns false for negative start offsets or when start is not before end', () => {
    expect(hasValidOffsets(makeMetadata(-1, 10))).toBe(false);
    expect(hasValidOffsets(makeMetadata(4, 4))).toBe(false);
    expect(hasValidOffsets(makeMetadata(6, 5))).toBe(false);
  });
});

function makeMetadata(offsetStart: number, offsetEnd: number): DocumentMetadata {
  return {
    documentId: 'doc-1',
    title: 'Document',
    sourceUrl: 'https://example.com',
    language: 'en',
    sectionPath: ['Introduction'],
    chunkId: 'chunk-1',
    chunkIndex: 0,
    offsetStart,
    offsetEnd,
  };
}
