/**
 * Domain Layer — Common value objects and base types.
 * DES-MG-001: Three-layer memory core model base types.
 */

// --- Language ---
export type LanguageCode = 'en' | 'ja' | 'mixed' | 'unknown';

const LANGUAGE_CODES = new Set<string>(['en', 'ja', 'mixed', 'unknown']);

export function isLanguageCode(value: unknown): value is LanguageCode {
  return typeof value === 'string' && LANGUAGE_CODES.has(value);
}

// --- Schema state ---
export type SchemaState = 'pending' | 'stable';

export function isSchemaState(value: unknown): value is SchemaState {
  return value === 'pending' || value === 'stable';
}

// --- Fact state ---
export type FactState = 'active' | 'inactive';

export function isFactState(value: unknown): value is FactState {
  return value === 'active' || value === 'inactive';
}

// --- Memory layer ---
export type MemoryLayer = 'ontology' | 'fact' | 'passage';

const MEMORY_LAYERS = new Set<string>(['ontology', 'fact', 'passage']);

export function isMemoryLayer(value: unknown): value is MemoryLayer {
  return typeof value === 'string' && MEMORY_LAYERS.has(value);
}

// --- Bridge kind ---
export type BridgeKind = 'type_based' | 'similarity_based';

export function isBridgeKind(value: unknown): value is BridgeKind {
  return value === 'type_based' || value === 'similarity_based';
}

// --- Provenance source ---
export type ProvenanceSource =
  | 'llm'
  | 'nlp'
  | 'dictionary'
  | 'thesaurus'
  | 'manual'
  | 'import';

const PROVENANCE_SOURCES = new Set<string>([
  'llm', 'nlp', 'dictionary', 'thesaurus', 'manual', 'import',
]);

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
