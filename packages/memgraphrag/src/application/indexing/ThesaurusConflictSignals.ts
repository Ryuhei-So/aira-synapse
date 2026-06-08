import type { IThesaurus } from '../../domain/dictionary/index.js';
import type { Fact } from '../../domain/memory/fact.js';

export async function computeThesaurusDistance(
  thesaurus: IThesaurus,
  left: Fact,
  right: Fact,
): Promise<number> {
  const relations = await thesaurus.getRelations(left.tailEntity);
  const match = relations.find((relation) =>
    relation.sourceTerm.toLowerCase() === right.tailEntity.toLowerCase()
    || relation.targetTerm.toLowerCase() === right.tailEntity.toLowerCase(),
  );

  if (!match) {
    return 1;
  }
  if (match.relationType === 'synonym') {
    return 0;
  }
  if (match.relationType === 'hypernym' || match.relationType === 'hyponym') {
    return 0.5;
  }
  return 0.75;
}
