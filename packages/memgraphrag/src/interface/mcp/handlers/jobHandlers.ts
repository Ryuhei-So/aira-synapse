import type { CorpusManager, IndexingService } from '../../../application/index.js';
import type { MemGraphRagRuntime } from '../../runtime/MemGraphRagRuntime.js';
import { SERVICE_TOKENS } from '../../runtime/MemGraphRagRuntime.js';
import {
  asRecord,
  jsonResult,
  optionalString,
  requiredArray,
  requiredIdentifier,
  requiredString,
} from '../handlerUtils.js';

function getIndexingService(runtime: MemGraphRagRuntime): IndexingService {
  return runtime.getService<IndexingService>(SERVICE_TOKENS.INDEXING_SERVICE);
}

function getCorpusManager(runtime: MemGraphRagRuntime): CorpusManager {
  return runtime.getService<CorpusManager>(SERVICE_TOKENS.CORPUS_MANAGER);
}

function toDocumentInput(value: unknown) {
  const record = asRecord(value);
  return {
    documentId: requiredIdentifier(record, 'document_id'),
    markdown: requiredString(record, 'markdown'),
    title: requiredString(record, 'title'),
    sourceUrl: requiredString(record, 'source_url'),
    doi: optionalString(record, 'doi'),
    sourceDb: optionalString(record, 'source_db'),
    sourceType: optionalString(record, 'source_type') as
      | 'pdf'
      | 'html'
      | 'docx'
      | 'pptx'
      | 'md'
      | undefined,
    language: optionalString(record, 'language') as
      | 'en'
      | 'ja'
      | 'mixed'
      | 'unknown'
      | undefined,
  };
}

export async function handleIndexDocuments(
  params: unknown,
  runtime: MemGraphRagRuntime,
) {
  const input = asRecord(params);
  const indexingService = getIndexingService(runtime);
  const documents = requiredArray(input, 'documents').map(toDocumentInput);
  const result = await indexingService.start({
    corpusId: requiredIdentifier(input, 'corpus_id'),
    documents,
  });

  return jsonResult({ job_id: result.jobId, status: 'pending' });
}

export async function handleGetJobStatus(
  params: unknown,
  runtime: MemGraphRagRuntime,
) {
  const input = asRecord(params);
  const manager = getCorpusManager(runtime);
  const result = await manager.getJobStatus(requiredIdentifier(input, 'job_id'));

  return jsonResult({
    job_id: result.jobId,
    status: result.status,
    processed_count: result.processedCount,
    total_count: result.totalCount,
    error_count: result.errorCount,
    errors: result.errors,
    summary: result.summary
      ? {
        added_nodes: result.summary.addedNodes,
        added_edges: result.summary.addedEdges,
        conflict_count: result.summary.conflictCount,
        skipped_count: result.summary.skippedCount,
      }
      : undefined,
  });
}

export async function handleCancelJob(
  params: unknown,
  runtime: MemGraphRagRuntime,
) {
  const input = asRecord(params);
  const manager = getCorpusManager(runtime);
  const result = await manager.cancelJob(requiredIdentifier(input, 'job_id'));

  return jsonResult({ job_id: result.jobId, status: result.status });
}

export async function handleDeleteDocument(
  params: unknown,
  runtime: MemGraphRagRuntime,
) {
  const input = asRecord(params);
  const indexingService = getIndexingService(runtime);
  const result = await indexingService.deleteDocument(
    requiredIdentifier(input, 'corpus_id'),
    requiredIdentifier(input, 'document_id'),
  );

  return jsonResult({
    corpus_id: result.corpusId,
    document_id: result.documentId,
    deleted_facts: result.deletedFacts,
    deleted_passages: result.deletedPassages,
    deleted_schemas: result.deletedSchemas,
    deleted_graph_nodes: result.deletedGraphNodes,
    deleted_graph_edges: result.deletedGraphEdges,
    schema_frequency_adjusted: result.schemaFrequencyAdjusted,
  });
}
