/**
 * Application Layer — Alias-aware context builder decorator.
 * DES-MG3-012: Prepends alias hint lines to the context for entities
 * that have known aliases or synonyms, using a greedy token-budget strategy.
 */

import type {
  IContextBuilder,
  ContextBundle,
  PPRResult,
} from '../../domain/retrieval/ppr.js';
import type { QueryRequest } from '../../domain/retrieval/memoryFilter.js';
import type { ITermDictionary } from '../../domain/dictionary/termDictionary.js';
import type { IThesaurus } from '../../domain/dictionary/thesaurus.js';
import type { LanguageCode } from '../../domain/memory/types.js';

/** Maximum fraction of contextTokenLimit used for alias hints */
const ALIAS_BUDGET_RATIO = 0.1;

export class AliasAwareContextBuilder implements IContextBuilder {
  constructor(
    private readonly inner: IContextBuilder,
    private readonly dictionary: ITermDictionary,
    private readonly thesaurus: IThesaurus,
    private readonly language: LanguageCode = 'en',
  ) {}

  public async build(query: QueryRequest, ranking: PPRResult): Promise<ContextBundle> {
    const base = await this.inner.build(query, ranking);

    // Get dictionary matches for the query
    const matches = await this.dictionary.match(query.text, this.language);
    if (matches.length === 0) {
      return base;
    }

    // Collect alias hints: entity → aliases from both dictionary and thesaurus
    const hints: { entity: string; aliases: string[] }[] = [];
    const seen = new Set<string>();

    for (const match of matches) {
      const canonical = match.entry.canonicalForm;
      if (seen.has(canonical.toLowerCase())) continue;
      seen.add(canonical.toLowerCase());

      const allAliases = new Set<string>(match.entry.aliases);

      // Also check thesaurus for synonyms
      const relations = await this.thesaurus.getRelations(canonical);
      for (const rel of relations) {
        if (rel.relationType === 'synonym') {
          allAliases.add(rel.targetTerm);
        }
      }

      // Remove canonical from aliases
      allAliases.delete(canonical);

      if (allAliases.size > 0) {
        hints.push({ entity: canonical, aliases: [...allAliases] });
      }
    }

    if (hints.length === 0) {
      return base;
    }

    // Greedy token-budget allocation
    const tokenBudget = Math.floor(query.contextTokenLimit * ALIAS_BUDGET_RATIO);
    let usedTokens = 0;
    const selectedHints: string[] = [];

    for (const hint of hints) {
      const line = `Note: "${hint.entity}" is also known as: ${hint.aliases.join(', ')}`;
      const lineTokens = Math.ceil(line.length / 4);
      if (usedTokens + lineTokens > tokenBudget) break;
      selectedHints.push(line);
      usedTokens += lineTokens;
    }

    if (selectedHints.length === 0) {
      return base;
    }

    const aliasSection = `## Entity Aliases\n\n${selectedHints.join('\n')}\n\n`;
    return {
      promptContext: aliasSection + base.promptContext,
      citedPassages: base.citedPassages,
      citedFacts: base.citedFacts,
      confidence: base.confidence,
      metadata: {
        ...base.metadata,
        aliasHintCount: selectedHints.length,
      },
    };
  }
}
