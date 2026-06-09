import type { DictionaryService } from '../../../application/index.js';
import type { MemGraphRagRuntime } from '../../runtime/MemGraphRagRuntime.js';
import { SERVICE_TOKENS } from '../../runtime/MemGraphRagRuntime.js';
import {
  asRecord,
  invalidParams,
  jsonResult,
  optionalString,
  requiredArray,
  requiredString,
  toDictionaryEntry,
} from '../handlerUtils.js';

function getDictionaryService(runtime: MemGraphRagRuntime): DictionaryService {
  return runtime.getService<DictionaryService>(SERVICE_TOKENS.DICTIONARY_SERVICE);
}

function toResultEnvelope(result: Awaited<ReturnType<DictionaryService['handle']>>) {
  return {
    action: result.action,
    result:
      result.entries
      ?? result.statistics
      ?? result.exportData
      ?? {},
  };
}

export async function handleManageDictionary(
  params: unknown,
  runtime: MemGraphRagRuntime,
) {
  const input = asRecord(params);
  const service = getDictionaryService(runtime);
  const action = requiredString(input, 'action') as Parameters<DictionaryService['handle']>[0]['action'];
  const entry = input['entry'] ? toDictionaryEntry(input['entry']) : undefined;
  const query = optionalString(input, 'query');
  const data = Array.isArray(input['data']) ? requiredArray(input, 'data').map(toDictionaryEntry) : undefined;

  if (action === 'add' && !entry) {
    throw invalidParams('entry is required for add', 'entry');
  }
  if (action === 'search' && (!query || query.trim().length === 0)) {
    throw invalidParams('query is required for search', 'query');
  }
  if (action === 'import' && !data) {
    throw invalidParams('data is required for import', 'data');
  }

  const result = await service.handle({
    corpusId: requiredString(input, 'corpus_id'),
    action,
    entry,
    query,
    data,
  });

  return jsonResult(toResultEnvelope(result));
}

export async function handleBuildDictionaryFromApi(
  params: unknown,
  runtime: MemGraphRagRuntime,
) {
  const input = asRecord(params);
  const service = getDictionaryService(runtime);
  const domains = requiredArray(input, 'domains');
  const maxPapers = input['max_papers'];
  if (typeof maxPapers !== 'number' || Number.isNaN(maxPapers) || maxPapers < 1) {
    throw invalidParams('max_papers must be a positive number', 'max_papers');
  }

  const result = await service.buildFromApi(
    requiredString(input, 'corpus_id'),
    domains.map((domain) => {
      if (typeof domain !== 'string' || domain.trim().length === 0) {
        throw invalidParams('domains must contain non-empty strings', 'domains');
      }
      return domain.trim();
    }),
    maxPapers,
  );

  return jsonResult({
    term_count: result.termCount,
    domain_distribution: result.domainDistribution,
  });
}
