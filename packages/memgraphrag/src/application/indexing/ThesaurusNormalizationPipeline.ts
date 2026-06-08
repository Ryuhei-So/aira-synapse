import type { CompositeExtractionRecord } from '../../domain/agent/index.js';
import type { IThesaurus } from '../../domain/dictionary/index.js';
import type { LanguageCode } from '../../domain/memory/types.js';

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

export async function normalizeExtractedEntities(
  records: readonly CompositeExtractionRecord[],
  thesaurus: IThesaurus,
  language: LanguageCode,
): Promise<readonly CompositeExtractionRecord[]> {
  const normalized: CompositeExtractionRecord[] = [];

  for (const record of records) {
    const entityMap = new Map<string, string>();
    for (const entity of record.rawEntities) {
      const result = await thesaurus.normalize(entity, language);
      entityMap.set(entity, result.canonicalTerm);
    }

    normalized.push({
      ...record,
      rawEntities: unique(record.rawEntities.map((entity) => entityMap.get(entity) ?? entity)),
      candidateFacts: record.candidateFacts.map((fact) => ({
        ...fact,
        headEntity: entityMap.get(fact.headEntity) ?? fact.headEntity,
        tailEntity: entityMap.get(fact.tailEntity) ?? fact.tailEntity,
      })),
      sourcePassage: {
        ...record.sourcePassage,
        entityMentions: unique(
          record.sourcePassage.entityMentions.map((entity) => entityMap.get(entity) ?? entity),
        ),
      },
    });
  }

  return normalized;
}
