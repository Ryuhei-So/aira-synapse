import type { ThesaurusService } from '../../../application/index.js';
import type { MemGraphRagRuntime } from '../../runtime/MemGraphRagRuntime.js';
import { SERVICE_TOKENS } from '../../runtime/MemGraphRagRuntime.js';
import {
  asRecord,
  invalidParams,
  jsonResult,
  optionalString,
  requiredArray,
  requiredIdentifier,
  requiredString,
  toThesaurusRelation,
} from '../handlerUtils.js';

function getThesaurusService(runtime: MemGraphRagRuntime): ThesaurusService {
  return runtime.getService<ThesaurusService>(SERVICE_TOKENS.THESAURUS_SERVICE);
}

function toResultEnvelope(result: Awaited<ReturnType<ThesaurusService['handle']>>) {
  return {
    action: result.action,
    result:
      result.relations
      ?? result.normalization
      ?? result.statistics
      ?? result.exportData
      ?? {},
  };
}

export async function handleManageThesaurus(
  params: unknown,
  runtime: MemGraphRagRuntime,
) {
  const input = asRecord(params);
  const service = getThesaurusService(runtime);
  const action = requiredString(input, 'action') as Parameters<ThesaurusService['handle']>[0]['action'];
  const relation = input['relation'] ? toThesaurusRelation(input['relation']) : undefined;
  const term = optionalString(input, 'term');
  const data = Array.isArray(input['data']) ? requiredArray(input, 'data').map(toThesaurusRelation) : undefined;

  if (action === 'add' && !relation) {
    throw invalidParams('relation is required for add', 'relation');
  }
  if (action === 'lookup' && (!term || term.trim().length === 0)) {
    throw invalidParams('term is required for lookup', 'term');
  }
  if (action === 'import' && !data) {
    throw invalidParams('data is required for import', 'data');
  }

  const result = await service.handle({
    corpusId: requiredIdentifier(input, 'corpus_id'),
    action,
    relation,
    term,
    data,
  });

  return jsonResult(toResultEnvelope(result));
}
