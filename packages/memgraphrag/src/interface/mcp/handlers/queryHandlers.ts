import type { CorpusManager, QueryService } from '../../../application/index.js';
import type { MemGraphRagRuntime } from '../../runtime/MemGraphRagRuntime.js';
import { SERVICE_TOKENS } from '../../runtime/MemGraphRagRuntime.js';
import {
  asRecord,
  jsonResult,
  optionalNumber,
  requiredString,
} from '../handlerUtils.js';

function getCorpusManager(runtime: MemGraphRagRuntime): CorpusManager {
  return runtime.getService<CorpusManager>(SERVICE_TOKENS.CORPUS_MANAGER);
}

function getQueryService(runtime: MemGraphRagRuntime): QueryService {
  return runtime.getService<QueryService>(SERVICE_TOKENS.QUERY_SERVICE);
}

export async function handleQuery(
  params: unknown,
  runtime: MemGraphRagRuntime,
) {
  const input = asRecord(params);
  const queryService = getQueryService(runtime);
  const topK = optionalNumber(input, 'top_k', 10);
  const topM = optionalNumber(input, 'top_m', 5);
  const threshold = optionalNumber(input, 'threshold', 0.5);
  const contextTokenLimit = optionalNumber(input, 'context_token_limit', 8000);

  const result = await queryService.query({
    corpusId: requiredString(input, 'corpus_id'),
    text: requiredString(input, 'query'),
    topK,
    topM,
    threshold,
    contextTokenLimit,
  });

  return jsonResult({
    response: result.response,
    citations: result.citations.map((citation) => ({
      passage_id: citation.passageId,
      title: citation.title,
      source_url: citation.sourceUrl,
      snippet: citation.snippet,
    })),
    entities: result.entities.map((entity) => ({
      term: entity.term,
      matched_text: entity.matchedText,
      boost_factor: entity.boostFactor,
    })),
    metrics: {
      dictionary_match_count: result.metrics.dictionaryMatchCount,
      expanded_terms: result.metrics.expandedTerms,
      fallback_triggered: result.metrics.fallbackTriggered,
      ppr_iterations: result.metrics.pprIterations,
      ppr_converged: result.metrics.pprConverged,
      cited_passage_count: result.metrics.citedPassageCount,
      llm_input_tokens: result.metrics.llmInputTokens,
      llm_output_tokens: result.metrics.llmOutputTokens,
      top_k: topK,
      top_m: topM,
      threshold,
    },
  });
}

export async function handleGetStats(
  params: unknown,
  runtime: MemGraphRagRuntime,
) {
  const input = asRecord(params);
  const manager = getCorpusManager(runtime);
  const result = await manager.getStats(requiredString(input, 'corpus_id'));

  return jsonResult({
    memory: result.memory,
    graph: result.graph,
    dictionaries: result.dictionaries,
    documents: result.documents.map((document) => ({
      document_id: document.documentId,
      title: document.title,
      indexed_at: document.indexedAt,
    })),
  });
}

export async function handleAnalyzeConflicts(
  params: unknown,
  runtime: MemGraphRagRuntime,
) {
  const input = asRecord(params);
  const manager = getCorpusManager(runtime);
  const result = await manager.analyzeConflicts(requiredString(input, 'corpus_id'));

  return jsonResult({
    conflicts: result.conflicts.map((conflict) => ({
      conflict_id: conflict.conflictId,
      type: conflict.type,
      resolution_state: conflict.resolutionState,
      confidence: conflict.confidence,
    })),
    distribution: result.distribution,
  });
}

export async function handleExportGraph(
  params: unknown,
  runtime: MemGraphRagRuntime,
) {
  const input = asRecord(params);
  const manager = getCorpusManager(runtime);
  const result = await manager.exportGraph(
    requiredString(input, 'corpus_id'),
    requiredString(input, 'format') as 'graphml' | 'json',
    optionalNumber(input, 'offset', 0),
    optionalNumber(input, 'limit', 10000),
  );

  return jsonResult({
    format: result.format,
    data: result.data,
    offset: result.offset,
    limit: result.limit,
    has_more: result.hasMore,
    next_offset: result.nextOffset,
    total_nodes: result.totalNodes,
  });
}
