import { createHash } from 'node:crypto';
import type { ITermDictionary, TermDictionaryEntry } from '../../domain/dictionary/index.js';

export interface DictionaryBuildResult {
  readonly termCount: number;
  readonly domainDistribution: Readonly<Record<string, number>>;
}

const STOP_WORDS = new Set([
  'about', 'after', 'also', 'analysis', 'and', 'approach', 'based', 'between', 'data', 'deep', 'for', 'from',
  'into', 'method', 'methods', 'model', 'models', 'new', 'paper', 'study', 'system', 'that', 'the', 'their',
  'these', 'this', 'using', 'with', 'within', 'without',
]);

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeTerm(term: string): string {
  return term.toLowerCase().replace(/[^a-z0-9\s-]/gi, ' ').replace(/\s+/g, ' ').trim();
}

function toTitleCase(term: string): string {
  return term.split(' ').filter(Boolean).map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1)).join(' ');
}

function buildTermId(corpusId: string, domain: string, canonicalForm: string): string {
  return `api:${corpusId}:${domain}:${createHash('sha1').update(canonicalForm).digest('hex').slice(0, 12)}`;
}

function extractTerms(text: string): readonly string[] {
  const normalized = text
    .replace(/[^a-zA-Z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) {
    return [];
  }

  const tokens = normalized.split(' ').map((token) => token.toLowerCase()).filter((token) => token.length >= 4 && !STOP_WORDS.has(token));
  const extracted = new Set<string>();

  for (const token of tokens) {
    extracted.add(token);
  }

  for (let index = 0; index < tokens.length - 1; index += 1) {
    const first = tokens[index];
    const second = tokens[index + 1];
    if (first && second) {
      extracted.add(`${first} ${second}`);
    }
  }

  return [...extracted];
}

export interface ScholarlyPaperSearchClient {
  searchPapers(
    query: string,
    fields?: readonly string[],
    limit?: number,
  ): Promise<readonly { title: string; abstract: string }[]>;
}

export class BuildDictionaryFromApi {
  public constructor(
    private readonly dictionary: ITermDictionary,
    private readonly client: ScholarlyPaperSearchClient,
  ) {}

  public async buildFromApi(
    corpusId: string,
    domains: readonly string[],
    maxPapers: number,
  ): Promise<DictionaryBuildResult> {
    const timestamp = nowIso();
    const aggregatedEntries: TermDictionaryEntry[] = [];
    const domainDistribution = new Map<string, number>();

    for (const rawDomain of domains) {
      const domain = rawDomain.trim();
      if (!domain) {
        continue;
      }

      const papers = await this.client.searchPapers(domain, ['paperId', 'title', 'abstract'], maxPapers);
      const counts = new Map<string, number>();

      for (const paper of papers) {
        for (const term of extractTerms(`${paper.title} ${paper.abstract}`)) {
          const canonicalForm = normalizeTerm(term);
          if (canonicalForm.length < 4) {
            continue;
          }
          counts.set(canonicalForm, (counts.get(canonicalForm) ?? 0) + 1);
        }
      }

      const domainEntries = [...counts.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .map(([canonicalForm, frequency]) => ({
          termId: buildTermId(corpusId, domain, canonicalForm),
          term: toTitleCase(canonicalForm),
          canonicalForm,
          domainCategory: domain,
          aliases: [],
          frequency,
          confidence: Math.min(1, 0.4 + (frequency / Math.max(papers.length, 1)) * 0.6),
          source: 'api' as const,
          version: 'api-v1',
          createdAt: timestamp,
          updatedAt: timestamp,
        }));

      aggregatedEntries.push(...domainEntries);
      domainDistribution.set(domain, domainEntries.length);
    }

    await this.dictionary.upsertEntries(aggregatedEntries);

    return {
      termCount: aggregatedEntries.length,
      domainDistribution: Object.fromEntries(domainDistribution),
    };
  }
}
