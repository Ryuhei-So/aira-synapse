/**
 * Application Layer — Use case orchestration services.
 * Depends on: Domain layer only.
 */

export { CorpusManager } from './corpus/CorpusManager.js';
export type {
  CorpusInfo,
  DeleteCorpusResult,
  CorpusStats,
  JobSummary,
  JobError,
  IndexingSummary,
  ConflictSummary,
  ConflictAnalysis,
  GraphExportPage,
} from './corpus/corpusDtos.js';

export {
  DefaultDictionaryService,
  type DictionaryAction,
  type DictionaryBuildResult,
  type DictionaryCommand,
  type DictionaryResult,
  type DictionaryService,
} from './dictionary/DictionaryService.js';

export {
  DefaultThesaurusService,
  ThesaurusValidator,
  summarizeRelations,
  type ThesaurusAction,
  type ThesaurusCommand,
  type ThesaurusResult,
  type ThesaurusService,
} from './thesaurus/ThesaurusService.js';

export {
  StageIExtractor,
  type IndexDocumentInput,
  type MarkdownQualityAssessment,
} from './indexing/StageIExtractor.js';
export {
  preprocessMarkdown,
  normalizeMarkdownUnicode,
  normalizeMarkdownWhitespace,
  stripControlCharacters,
} from './indexing/MarkdownPreprocessor.js';
export {
  chunkMarkdownDocument,
  toExtractionChunk,
  type MarkdownChunk,
  type MarkdownChunkFeatures,
  type ChunkDocumentRequest,
} from './indexing/MarkdownChunker.js';
export { StageIICanonicalizer, mergeSchemas } from './indexing/StageIICanonicalizer.js';
export {
  detectConflicts,
  resolveConflicts,
  recordConflictAudit,
  type ConflictDetectionConfig,
  type ConflictResolutionAuditEntry,
} from './indexing/StageIIIConflictPipeline.js';
export {
  projectGraph,
  buildTypeBasedBridges,
  buildSimilarityBridges,
  upsertVectors,
} from './indexing/StageIVGraphProjector.js';
export {
  DeleteDocumentService,
  type DeleteDocumentResult,
} from './indexing/DeleteDocumentService.js';
export {
  recoverMissedCompositeTerms,
  boostEntities,
} from './indexing/DictionaryBoostPipeline.js';
export { normalizeExtractedEntities } from './indexing/ThesaurusNormalizationPipeline.js';
export { computeThesaurusDistance } from './indexing/ThesaurusConflictSignals.js';
export { buildThesaurusGraphExpansion } from './indexing/ThesaurusGraphExpansion.js';
export {
  AsyncJobRunner,
  type ProcessDocumentResult,
  type DocumentIndexingPipeline,
} from './indexing/AsyncJobRunner.js';
export {
  DefaultIndexingService,
  type IndexingService,
  type DeleteDocumentPort,
  type IndexDocumentsCommand,
} from './indexing/IndexingService.js';

export {
  ThesaurusExpansionPolicy,
  type ThesaurusExpansionOptions,
} from './query/ThesaurusExpansionPolicy.js';
export {
  DefaultQueryService,
  ContextBuilderService,
  type CitationDto,
  type EntityHit,
  type QueryMetrics,
  type QueryResponse,
  type QueryService,
  type QueryServiceDependencies,
  type ContextBuilderDependencies,
} from './query/QueryService.js';
