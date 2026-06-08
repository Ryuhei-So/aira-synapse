import type {
  IThesaurus,
  NormalizationResult,
  ThesaurusRelation,
  ThesaurusRelationType,
} from '../../domain/dictionary/index.js';
import type { LanguageCode } from '../../domain/memory/types.js';

export type ThesaurusAction = 'add' | 'lookup' | 'stats' | 'import' | 'export';

export interface ThesaurusCommand {
  readonly corpusId: string;
  readonly action: ThesaurusAction;
  readonly relation?: ThesaurusRelation;
  readonly term?: string;
  readonly data?: readonly ThesaurusRelation[];
}

export interface ThesaurusResult {
  readonly action: ThesaurusAction;
  readonly relations?: readonly ThesaurusRelation[];
  readonly normalization?: NormalizationResult;
  readonly statistics?: Readonly<Record<string, unknown>>;
  readonly exportData?: Readonly<Record<string, unknown>>;
}

export interface ThesaurusService {
  handle(command: ThesaurusCommand): Promise<ThesaurusResult>;
}

function normalizeTerm(value: string): string {
  return value.trim().toLowerCase();
}

function relatedTerm(relation: ThesaurusRelation, term: string): string {
  return normalizeTerm(relation.sourceTerm) === normalizeTerm(term)
    ? relation.targetTerm
    : relation.sourceTerm;
}

export class ThesaurusValidator {
  public validate(relations: readonly ThesaurusRelation[]): void {
    const adjacency = new Map<string, Set<string>>();

    for (const relation of relations) {
      if (relation.relationType !== 'hypernym' && relation.relationType !== 'hyponym') {
        continue;
      }

      const source = normalizeTerm(relation.sourceTerm);
      const target = normalizeTerm(relation.targetTerm);
      const edgeSource = relation.relationType === 'hypernym' ? source : target;
      const edgeTarget = relation.relationType === 'hypernym' ? target : source;

      const targets = adjacency.get(edgeSource) ?? new Set<string>();
      targets.add(edgeTarget);
      adjacency.set(edgeSource, targets);
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();

    const dfs = (node: string): boolean => {
      if (visiting.has(node)) {
        return true;
      }
      if (visited.has(node)) {
        return false;
      }

      visiting.add(node);
      for (const next of adjacency.get(node) ?? []) {
        if (dfs(next)) {
          return true;
        }
      }
      visiting.delete(node);
      visited.add(node);
      return false;
    };

    for (const node of adjacency.keys()) {
      if (dfs(node)) {
        throw new Error('Thesaurus import contains a hypernym cycle');
      }
    }
  }
}

export class DefaultThesaurusService implements ThesaurusService {
  public constructor(
    private readonly thesaurus: IThesaurus,
    private readonly validator = new ThesaurusValidator(),
    private readonly language: LanguageCode = 'unknown',
  ) {}

  public async handle(command: ThesaurusCommand): Promise<ThesaurusResult> {
    if (command.corpusId.trim().length === 0) {
      throw new Error('corpusId is required');
    }

    switch (command.action) {
      case 'add': {
        if (!command.relation) {
          throw new Error('relation is required for add');
        }
        const current = await this.thesaurus.exportJson();
        const currentRelations = Array.isArray(current['thesaurusRelations'])
          ? (current['thesaurusRelations'] as readonly ThesaurusRelation[])
          : [];
        const merged = [...currentRelations, command.relation];
        this.validator.validate(merged);
        await this.thesaurus.importJson({
          corpusId: command.corpusId,
          thesaurusRelations: merged,
        });
        return { action: 'add', relations: [command.relation] };
      }
      case 'lookup': {
        if (!command.term || command.term.trim().length === 0) {
          throw new Error('term is required for lookup');
        }
        const [relations, normalization] = await Promise.all([
          this.thesaurus.getRelations(command.term),
          this.thesaurus.normalize(command.term, this.language),
        ]);
        return { action: 'lookup', relations, normalization };
      }
      case 'stats': {
        const exportData = await this.thesaurus.exportJson();
        const relations = Array.isArray(exportData['thesaurusRelations'])
          ? (exportData['thesaurusRelations'] as readonly ThesaurusRelation[])
          : [];
        const byType = relations.reduce<Record<ThesaurusRelationType, number>>((acc, relation) => {
          acc[relation.relationType] = (acc[relation.relationType] ?? 0) + 1;
          return acc;
        }, {
          synonym: 0,
          hypernym: 0,
          hyponym: 0,
          related: 0,
        });
        return {
          action: 'stats',
          statistics: {
            totalRelations: relations.length,
            byType: Object.fromEntries(
              Object.entries(byType).filter(([, count]) => count > 0),
            ),
            bidirectionalCount: relations.filter((relation) => relation.bidirectional).length,
          },
        };
      }
      case 'import': {
        const relations = command.data ?? [];
        this.validator.validate(relations);
        await this.thesaurus.importJson({
          corpusId: command.corpusId,
          thesaurusRelations: relations,
        });
        return { action: 'import', relations };
      }
      case 'export': {
        return { action: 'export', exportData: await this.thesaurus.exportJson() };
      }
    }
  }
}

export function summarizeRelations(term: string, relations: readonly ThesaurusRelation[]): readonly string[] {
  return relations.map((relation) => `${term} -> ${relatedTerm(relation, term)} (${relation.relationType})`);
}
