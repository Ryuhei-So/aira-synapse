import type { CorpusManager } from '../../../application/index.js';
import type { MemGraphRagRuntime } from '../../runtime/MemGraphRagRuntime.js';
import { SERVICE_TOKENS } from '../../runtime/MemGraphRagRuntime.js';
import { asRecord, jsonResult, optionalString, requiredIdentifier, requiredString } from '../handlerUtils.js';

function getCorpusManager(runtime: MemGraphRagRuntime): CorpusManager {
  return runtime.getService<CorpusManager>(SERVICE_TOKENS.CORPUS_MANAGER);
}

export async function handleCreateCorpus(
  params: unknown,
  runtime: MemGraphRagRuntime,
) {
  const input = asRecord(params);
  const manager = getCorpusManager(runtime);
  const result = await manager.create(
    requiredString(input, 'name'),
    optionalString(input, 'description'),
  );

  return jsonResult({
    corpus_id: result.corpusId,
    name: result.name,
    description: result.description,
    document_count: result.documentCount,
    node_count: result.nodeCount,
    created_at: result.createdAt,
  });
}

export async function handleDeleteCorpus(
  params: unknown,
  runtime: MemGraphRagRuntime,
) {
  const input = asRecord(params);
  const manager = getCorpusManager(runtime);
  const result = await manager.delete(requiredIdentifier(input, 'corpus_id'));

  return jsonResult({
    corpus_id: result.corpusId,
    cancelled_jobs: result.cancelledJobs,
    deleted_documents: result.deletedDocuments,
    deleted_nodes: result.deletedNodes,
    deleted_edges: result.deletedEdges,
    deleted_vector_records: result.deletedVectorRecords,
  });
}

export async function handleListCorpora(
  params: unknown,
  runtime: MemGraphRagRuntime,
) {
  asRecord(params);
  const manager = getCorpusManager(runtime);
  const corpora = await manager.list();

  return jsonResult({
    corpora: corpora.map((corpus) => ({
      corpus_id: corpus.corpusId,
      name: corpus.name,
      description: corpus.description,
      document_count: corpus.documentCount,
      node_count: corpus.nodeCount,
      created_at: corpus.createdAt,
    })),
  });
}
