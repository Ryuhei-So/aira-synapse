import { describe, expect, it } from 'vitest';
import {
  assertCorpusScoped,
  isBridgeKind,
  isFactState,
  isLanguageCode,
  isMemoryLayer,
  isProvenanceSource,
  isSchemaState,
} from '../../../../src/domain/memory/types.js';

describe('TASK-MG-006: memory type guards and corpus scoping', () => {
  it('accepts supported language codes and rejects unsupported values', () => {
    expect(isLanguageCode('en')).toBe(true);
    expect(isLanguageCode('ja')).toBe(true);
    expect(isLanguageCode('mixed')).toBe(true);
    expect(isLanguageCode('unknown')).toBe(true);

    expect(isLanguageCode('fr')).toBe(false);
    expect(isLanguageCode('')).toBe(false);
    expect(isLanguageCode(1)).toBe(false);
    expect(isLanguageCode(null)).toBe(false);
  });

  it('accepts supported schema states and rejects unsupported values', () => {
    expect(isSchemaState('pending')).toBe(true);
    expect(isSchemaState('stable')).toBe(true);

    expect(isSchemaState('draft')).toBe(false);
    expect(isSchemaState('')).toBe(false);
    expect(isSchemaState(undefined)).toBe(false);
  });

  it('accepts supported fact states and rejects unsupported values', () => {
    expect(isFactState('active')).toBe(true);
    expect(isFactState('inactive')).toBe(true);

    expect(isFactState('archived')).toBe(false);
    expect(isFactState('')).toBe(false);
    expect(isFactState(false)).toBe(false);
  });

  it('accepts supported memory layers and rejects unsupported values', () => {
    expect(isMemoryLayer('ontology')).toBe(true);
    expect(isMemoryLayer('fact')).toBe(true);
    expect(isMemoryLayer('passage')).toBe(true);

    expect(isMemoryLayer('document')).toBe(false);
    expect(isMemoryLayer('')).toBe(false);
    expect(isMemoryLayer({})).toBe(false);
  });

  it('accepts supported bridge kinds and rejects unsupported values', () => {
    expect(isBridgeKind('type_based')).toBe(true);
    expect(isBridgeKind('similarity_based')).toBe(true);

    expect(isBridgeKind('manual')).toBe(false);
    expect(isBridgeKind('')).toBe(false);
    expect(isBridgeKind([])).toBe(false);
  });

  it('accepts supported provenance sources and rejects unsupported values', () => {
    expect(isProvenanceSource('llm')).toBe(true);
    expect(isProvenanceSource('nlp')).toBe(true);
    expect(isProvenanceSource('dictionary')).toBe(true);
    expect(isProvenanceSource('thesaurus')).toBe(true);
    expect(isProvenanceSource('manual')).toBe(true);
    expect(isProvenanceSource('import')).toBe(true);

    expect(isProvenanceSource('user')).toBe(false);
    expect(isProvenanceSource('')).toBe(false);
    expect(isProvenanceSource({ source: 'llm' })).toBe(false);
  });

  it('throws when corpusId is empty or whitespace and passes for a valid corpusId', () => {
    expect(() => assertCorpusScoped({ corpusId: '' })).toThrow(
      'corpusId must be a non-empty string',
    );
    expect(() => assertCorpusScoped({ corpusId: '   ' })).toThrow(
      'corpusId must be a non-empty string',
    );
    expect(() => assertCorpusScoped({ corpusId: 'corpus-1' })).not.toThrow();
  });
});
