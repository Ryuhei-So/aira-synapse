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
export { SemanticScholarCache } from './api/SemanticScholarCache.js';
export { SemanticScholarClient } from './api/SemanticScholarClient.js';
export { Bm25LexicalRetriever } from './retrieval/Bm25LexicalRetriever.js';
export { MemorySampler } from './logging/MemorySampler.js';
export { StructuredLogger, type LogLevel, type LogContext, type StructuredLogEntry } from './logging/StructuredLogger.js';
export { AuditLogger, type AuditRecord } from './logging/AuditLogger.js';
export { SecretMasker, redactSecrets } from './security/SecretMasker.js';
export { SchemaVersionManager } from './storage/SchemaVersionManager.js';
