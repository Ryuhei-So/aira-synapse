/**
 * Infrastructure Layer — Concrete adapters for domain ports.
 * Depends on: Domain layer only.
 */

export { SQLiteGraphStore } from './storage/SQLiteGraphStore.js';
export { SQLiteMemoryStore } from './storage/SQLiteMemoryStore.js';
export { SnapshotBackedIndexingMemory } from './storage/SnapshotBackedIndexingMemory.js';
export { SQLiteLexiconStore } from './storage/SQLiteLexiconStore.js';
export { FileVectorIndex } from './storage/FileVectorIndex.js';
export { CachedMemoryStore } from './storage/cached/CachedMemoryStore.js';
export { CachedGraphProjection } from './storage/cached/CachedGraphProjection.js';
export { CachedFileVectorIndex } from './storage/cached/CachedFileVectorIndex.js';
export { OpenAILLMProvider } from './llm/OpenAILLMProvider.js';
export { OpenAIEmbeddingProvider } from './embedding/OpenAIEmbeddingProvider.js';
export { BatchEmbeddingProvider } from './embedding/BatchEmbeddingProvider.js';
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
// Neo4j adapters
export { Neo4jConnectionPool, type Neo4jConnectionOptions, type INeo4jConnectionPool } from './storage/neo4j/Neo4jConnection.js';
export { Neo4jGraphStore } from './storage/neo4j/Neo4jGraphStore.js';
export { Neo4jVectorIndex } from './storage/neo4j/Neo4jVectorIndex.js';
export { Neo4jMemoryStore } from './storage/neo4j/Neo4jMemoryStore.js';
export { Neo4jGraphProjection } from './storage/neo4j/Neo4jGraphProjection.js';
export { Neo4jLexicalRetriever } from './storage/neo4j/Neo4jLexicalRetriever.js';
export {
  AiraGraphDbNativeClient,
  type AiraGraphDbRpcClient,
  type AiraGraphDbTrafficEvent,
  type AiraGraphDbTrafficObserver,
  type NativeRequestLimits,
} from './storage/aira-graphdb/NativeClient.js';
export { AiraGraphDbIndexingMemory } from './storage/aira-graphdb/AiraGraphDbIndexingMemory.js';
export {
  AiraGraphDbGraphStore,
  AiraGraphDbVectorIndex,
  AiraGraphDbMemoryStore,
  AiraGraphDbGraphProjection,
  AiraGraphDbLexicalRetriever,
} from './storage/aira-graphdb/AiraGraphDbAdapters.js';
export { createAiraGraphDbAdapters, type AiraGraphDbStorageOptions } from './storage/ladybug/storageFactory.js';
