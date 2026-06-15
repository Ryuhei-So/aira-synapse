import type {
  IThesaurus,
  QueryExpansion,
  ThesaurusRelation,
} from '../../domain/dictionary/index.js';
import type { ITermDictionary } from '../../domain/dictionary/termDictionary.js';
import type { LanguageCode } from '../../domain/memory/types.js';

export interface ThesaurusExpansionOptions {
  readonly synonymLimit?: number;
  readonly hypernymLimit?: number;
  readonly language?: LanguageCode;
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
    private readonly dictionary?: ITermDictionary,
  ) {}

  public async expandQuery(query: string): Promise<QueryExpansion> {
    const expandedTerms: string[] = [];
    const seen = new Set(tokenize(query).map((t) => t.toLowerCase()));
    let synonymCount = 0;
    let hypernymCount = 0;

    // Phase 1: Dictionary-based phrase matching (longest-match-first)
    if (this.dictionary) {
      const matches = await this.dictionary.match(query, this.options.language ?? 'en');
      // Sort by matched text length descending (longest first)
      const sorted = [...matches].sort((a, b) => b.matchedText.length - a.matchedText.length);
      for (const match of sorted) {
        // Get thesaurus relations for the canonical form
        const relations = await this.thesaurus.getRelations(match.entry.canonicalForm);
        for (const relation of relations) {
          if (relation.relationType === 'synonym' && synonymCount >= (this.options.synonymLimit ?? 3)) continue;
          if (relation.relationType === 'hypernym' && hypernymCount >= (this.options.hypernymLimit ?? 2)) continue;
          if (relation.relationType !== 'synonym' && relation.relationType !== 'hypernym') continue;

          const candidate = relatedTerm(match.entry.canonicalForm, relation);
          const normalized = candidate.toLowerCase();
          if (seen.has(normalized)) continue;
          seen.add(normalized);
          expandedTerms.push(candidate);
          if (relation.relationType === 'synonym') synonymCount++;
          else hypernymCount++;
        }
      }
    }

    // Phase 2: Token-level thesaurus expansion (existing logic)
    const tokens = tokenize(query);
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
