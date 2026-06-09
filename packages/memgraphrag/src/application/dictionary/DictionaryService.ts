import type {
  DictionaryStatistics,
  ITermDictionary,
  TermDictionaryEntry,
} from '../../domain/dictionary/index.js';
import type { LanguageCode } from '../../domain/memory/types.js';

export type DictionaryAction = 'add' | 'search' | 'stats' | 'import' | 'export';

export interface DictionaryCommand {
  readonly corpusId: string;
  readonly action: DictionaryAction;
  readonly entry?: TermDictionaryEntry;
  readonly query?: string;
  readonly data?: readonly TermDictionaryEntry[];
}

export interface DictionaryResult {
  readonly action: DictionaryAction;
  readonly entries?: readonly TermDictionaryEntry[];
  readonly statistics?: DictionaryStatistics;
  readonly exportData?: Readonly<Record<string, unknown>>;
}

export interface DictionaryBuildResult {
  readonly termCount: number;
  readonly domainDistribution: Readonly<Record<string, number>>;
}

export interface DictionaryService {
  handle(command: DictionaryCommand): Promise<DictionaryResult>;
  buildFromApi(
    corpusId: string,
    domains: readonly string[],
    maxPapers: number,
  ): Promise<DictionaryBuildResult>;
}

function assertCorpusId(corpusId: string): void {
  if (corpusId.trim().length === 0) {
    throw new Error('corpusId is required');
  }
}

export class DefaultDictionaryService implements DictionaryService {
  public constructor(
    private readonly dictionary: ITermDictionary,
    private readonly language: LanguageCode = 'unknown',
  ) {}

  public async buildFromApi(
    _corpusId: string,
    _domains: readonly string[],
    _maxPapers: number,
  ): Promise<DictionaryBuildResult> {
    throw new Error('FEATURE_REQUIRES_API: external dictionary build is not configured');
  }

  public async handle(command: DictionaryCommand): Promise<DictionaryResult> {
    assertCorpusId(command.corpusId);

    switch (command.action) {
      case 'add': {
        if (!command.entry) {
          throw new Error('entry is required for add');
        }
        await this.dictionary.upsertEntries([command.entry]);
        return { action: 'add', entries: [command.entry] };
      }
      case 'search': {
        if (!command.query || command.query.trim().length === 0) {
          throw new Error('query is required for search');
        }
        const matches = await this.dictionary.match(command.query, this.language);
        return {
          action: 'search',
          entries: matches.map((match) => match.entry),
        };
      }
      case 'stats': {
        const statistics = await this.dictionary.getStatistics();
        return { action: 'stats', statistics };
      }
      case 'import': {
        const entries = command.data ?? [];
        await this.dictionary.importJson({
          corpusId: command.corpusId,
          termDictionary: entries,
        });
        return { action: 'import', entries };
      }
      case 'export': {
        const exportData = await this.dictionary.exportJson();
        return { action: 'export', exportData };
      }
    }
  }
}
