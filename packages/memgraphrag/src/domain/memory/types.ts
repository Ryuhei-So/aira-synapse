/**
 * Domain Layer — Common value objects and base types.
 * DES-MG-001: Three-layer memory core model base types.
 */

// --- Language ---
export const LANGUAGE_CODE_VALUES = ['en', 'ja', 'mixed', 'unknown'] as const;
export type LanguageCode = typeof LANGUAGE_CODE_VALUES[number];

const LANGUAGE_CODES = new Set<string>(LANGUAGE_CODE_VALUES);

export function isLanguageCode(value: unknown): value is LanguageCode {
  return typeof value === 'string' && LANGUAGE_CODES.has(value);
}

// --- Schema state ---
export const SCHEMA_STATE_VALUES = ['pending', 'stable'] as const;
export type SchemaState = typeof SCHEMA_STATE_VALUES[number];
const SCHEMA_STATES = new Set<string>(SCHEMA_STATE_VALUES);

export function isSchemaState(value: unknown): value is SchemaState {
  return typeof value === 'string' && SCHEMA_STATES.has(value);
}

// --- Fact state ---
export const FACT_STATE_VALUES = ['active', 'inactive'] as const;
export type FactState = typeof FACT_STATE_VALUES[number];
const FACT_STATES = new Set<string>(FACT_STATE_VALUES);

export function isFactState(value: unknown): value is FactState {
  return typeof value === 'string' && FACT_STATES.has(value);
}

// --- Memory layer ---
export type MemoryLayer = 'ontology' | 'fact' | 'passage' | 'entity';

const MEMORY_LAYERS = new Set<string>(['ontology', 'fact', 'passage', 'entity']);

export function isMemoryLayer(value: unknown): value is MemoryLayer {
  return typeof value === 'string' && MEMORY_LAYERS.has(value);
}

// --- Bridge kind ---
export type BridgeKind = 'type_based' | 'similarity_based';

export function isBridgeKind(value: unknown): value is BridgeKind {
  return value === 'type_based' || value === 'similarity_based';
}

// --- Provenance source ---
export const PROVENANCE_SOURCE_VALUES = [
  'llm', 'nlp', 'dictionary', 'thesaurus', 'manual', 'import',
] as const;
export type ProvenanceSource = typeof PROVENANCE_SOURCE_VALUES[number];

const PROVENANCE_SOURCES = new Set<string>(PROVENANCE_SOURCE_VALUES);

export function isProvenanceSource(value: unknown): value is ProvenanceSource {
  return typeof value === 'string' && PROVENANCE_SOURCES.has(value);
}

// --- Mixins ---
export interface Timestamped {
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CorpusScoped {
  readonly corpusId: string;
}

/** Asserts that a corpus-scoped value has a non-empty corpusId. */
export function assertCorpusScoped(obj: CorpusScoped): void {
  if (!obj.corpusId || obj.corpusId.trim().length === 0) {
    throw new Error('corpusId must be a non-empty string');
  }
}
