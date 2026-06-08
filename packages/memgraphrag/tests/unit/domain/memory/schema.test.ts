import { describe, expect, it } from 'vitest';
import {
  computeCanonicalKey,
  hasExactlyOneCanonicalAlias,
  shouldPromoteToStable,
} from '../../../../src/domain/memory/schema.js';
import type { SchemaAlias } from '../../../../src/domain/memory/schema.js';

describe('TASK-MG-007: memory schema helpers', () => {
  it('returns true only when exactly one alias is canonical', () => {
    const noneCanonical: SchemaAlias[] = [
      makeAlias('Protein', false),
      makeAlias('タンパク質', false),
    ];
    const oneCanonical: SchemaAlias[] = [
      makeAlias('Protein', true),
      makeAlias('タンパク質', false),
    ];
    const twoCanonical: SchemaAlias[] = [
      makeAlias('Protein', true),
      makeAlias('タンパク質', true),
    ];

    expect(hasExactlyOneCanonicalAlias(noneCanonical)).toBe(false);
    expect(hasExactlyOneCanonicalAlias(oneCanonical)).toBe(true);
    expect(hasExactlyOneCanonicalAlias(twoCanonical)).toBe(false);
  });

  it('promotes to stable when frequency meets or exceeds the threshold', () => {
    expect(shouldPromoteToStable(3, 3)).toBe(true);
    expect(shouldPromoteToStable(4, 3)).toBe(true);
    expect(shouldPromoteToStable(2, 3)).toBe(false);
  });

  it('computes a lowercase trimmed canonical key', () => {
    expect(computeCanonicalKey('  Gene ', ' ENCODES ', ' Protein  ')).toBe(
      'gene::encodes::protein',
    );
  });
});

function makeAlias(label: string, isCanonical: boolean): SchemaAlias {
  return {
    label,
    language: 'en',
    source: 'manual',
    confidence: 0.9,
    isCanonical,
  };
}
