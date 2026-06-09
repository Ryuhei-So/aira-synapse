import type { ContextBundle } from '../../domain/retrieval/ppr.js';

export interface TemplateContextBundle extends ContextBundle {
  readonly entities?: readonly string[];
}

function truncate(text: string, limit = 160): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

export class TemplateResponseGenerator {
  public generate(contextBundle: TemplateContextBundle): string {
    const snippets = contextBundle.citedPassages.slice(0, 3).map((passage) => truncate(passage.text));
    const entities = unique([
      ...(contextBundle.entities ?? []),
      ...contextBundle.citedFacts.flatMap((fact) => [fact.headEntity, fact.tailEntity]),
      ...contextBundle.citedPassages.flatMap((passage) => passage.entityMentions),
    ]).slice(0, 8);
    const citations = unique(contextBundle.citedPassages.map((passage) => {
      const title = passage.metadata.title || passage.passageId;
      return passage.metadata.sourceUrl ? `${title} (${passage.metadata.sourceUrl})` : title;
    }));

    return `Based on ${contextBundle.citedPassages.length} sources: ${snippets.join(' | ') || 'No direct passage snippets available.'} Key entities: ${entities.join(', ') || 'none'}. Sources: ${citations.join('; ') || 'none'}`;
  }
}
