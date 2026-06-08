import type { CompositeExtractionRecord } from '../../domain/agent/index.js';
import type { ITermDictionary } from '../../domain/dictionary/index.js';
import type { LanguageCode } from '../../domain/memory/types.js';

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

export async function recoverMissedCompositeTerms(
  text: string,
  dictionary: ITermDictionary,
  language: LanguageCode,
): Promise<readonly string[]> {
  const matches = await dictionary.match(text, language);
  return unique(
    matches
      .map((match) => match.entry.canonicalForm)
      .filter((term) => term.includes(' ') || term.includes('-')),
  );
}

export async function boostEntities(
  records: readonly CompositeExtractionRecord[],
  dictionary: ITermDictionary,
  language: LanguageCode,
): Promise<readonly CompositeExtractionRecord[]> {
  const boosted: CompositeExtractionRecord[] = [];

  for (const record of records) {
    const recovered = await recoverMissedCompositeTerms(record.chunk.text, dictionary, language);
    const entities = unique([...record.rawEntities, ...recovered]);
    boosted.push({
      ...record,
      rawEntities: entities,
      sourcePassage: {
        ...record.sourcePassage,
        entityMentions: unique([...record.sourcePassage.entityMentions, ...recovered]),
      },
    });
  }

  return boosted;
}
