import type {
  IThesaurus,
  QueryExpansion,
  ThesaurusRelation,
} from '../../domain/dictionary/index.js';

export interface ThesaurusExpansionOptions {
  readonly synonymLimit?: number;
  readonly hypernymLimit?: number;
}

function tokenize(query: string): readonly string[] {
  return query
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function relatedTerm(term: string, relation: ThesaurusRelation): string {
  return relation.sourceTerm.toLowerCase() === term.toLowerCase()
    ? relation.targetTerm
    : relation.sourceTerm;
}

export class ThesaurusExpansionPolicy {
  public constructor(
    private readonly thesaurus: IThesaurus,
    private readonly options: ThesaurusExpansionOptions = {},
  ) {}

  public async expandQuery(query: string): Promise<QueryExpansion> {
    const tokens = tokenize(query);
    const expandedTerms: string[] = [];
    const seen = new Set(tokens.map((token) => token.toLowerCase()));
    let synonymCount = 0;
    let hypernymCount = 0;

    for (const token of tokens) {
      const relations = await this.thesaurus.getRelations(token);
      for (const relation of relations) {
        if (relation.relationType === 'synonym' && synonymCount >= (this.options.synonymLimit ?? 3)) {
          continue;
        }
        if (relation.relationType === 'hypernym' && hypernymCount >= (this.options.hypernymLimit ?? 2)) {
          continue;
        }
        if (relation.relationType !== 'synonym' && relation.relationType !== 'hypernym') {
          continue;
        }

        const candidate = relatedTerm(token, relation);
        const normalized = candidate.toLowerCase();
        if (seen.has(normalized)) {
          continue;
        }
        seen.add(normalized);
        expandedTerms.push(candidate);
        if (relation.relationType === 'synonym') {
          synonymCount += 1;
        } else {
          hypernymCount += 1;
        }
      }
    }

    return {
      originalQuery: query,
      expandedTerms,
      rewrittenQuery: expandedTerms.length === 0 ? query : `${query} ${expandedTerms.join(' ')}`,
    };
  }
}
