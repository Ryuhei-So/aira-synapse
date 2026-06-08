/**
 * Infrastructure Layer — Concrete adapters for domain ports.
 * Depends on: Domain layer only.
 */

export { SQLiteGraphStore } from './storage/SQLiteGraphStore.js';
export { SQLiteMemoryStore } from './storage/SQLiteMemoryStore.js';
export { SQLiteLexiconStore } from './storage/SQLiteLexiconStore.js';
export { FileVectorIndex } from './storage/FileVectorIndex.js';
export { OpenAILLMProvider } from './llm/OpenAILLMProvider.js';
export { OpenAIEmbeddingProvider } from './embedding/OpenAIEmbeddingProvider.js';
export { RegexExtractor } from './nlp/RegexExtractor.js';
export { PythonSidecarExtractor } from './nlp/PythonSidecarExtractor.js';
export {
  openAndMigrate,
  openDatabase,
  runMigrations,
  type MigrationResult,
} from './storage/migrate.js';
