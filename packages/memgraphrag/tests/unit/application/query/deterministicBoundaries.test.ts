import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseDbSpec, validateDbSpecs } from '../../../../src/application/query/dbValidation.js';
import { SQLiteGraphProjection } from '../../../../src/application/query/SQLiteGraphProjection.js';
import type {
  DictionaryMatch,
  ITermDictionary,
  TermDictionaryEntry,
} from '../../../../src/domain/dictionary/termDictionary.js';
import type { GraphEdge, GraphNode, IGraphStore } from '../../../../src/domain/storage/graphStore.js';

function makeDictionaryMatch(
  term: string,
  confidence: number,
  aliases: readonly string[] = [],
  category = 'science',
): DictionaryMatch {
  const entry: TermDictionaryEntry = {
    termId: `term:${term}`,
    term,
    canonicalForm: `Canonical ${term}`,
    domainCategory: category,
    aliases,
    frequency: 1,
    confidence,
    source: 'manual',
    version: '1',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  };
  return { entry, matchedText: term, boostFactor: 1 };
}

function makeDictionary(matches: readonly DictionaryMatch[]): ITermDictionary {
  return {
    match: vi.fn().mockResolvedValue(matches),
    upsertEntries: vi.fn(),
    suggest: vi.fn().mockResolvedValue([]),
    exportJson: vi.fn().mockResolvedValue({}),
    importJson: vi.fn(),
    getStatistics: vi.fn(),
  };
}

async function loadDictionaryContextEnricher() {
  vi.stubEnv('DICT_MAX_HINTS', '5');
  vi.stubEnv('DICT_MIN_CONFIDENCE', '0.7');
  vi.resetModules();
  return (await import('../../../../src/application/query/DictionaryContextEnricher.js'))
    .DictionaryContextEnricher;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('query boundary utilities', () => {
  describe('database specification validation', () => {
    it('parses alias assignments and derives an id from a basename', () => {
      expect(parseDbSpec('papers=/var/lib/literature/papers.agdb')).toEqual({
        dbId: 'papers',
        dbPath: '/var/lib/literature/papers.agdb',
      });
      expect(parseDbSpec('nested/library.agdb')).toEqual({
        dbId: 'library',
        dbPath: 'nested/library.agdb',
      });
    });

    it('reports invalid ids, duplicate ids, unsupported extensions, and missing paths', () => {
      const directory = mkdtempSync(join(tmpdir(), 'memgraphrag-db-spec-'));
      const invalidPath = join(directory, 'not-a-database.sqlite');
      const missingOne = join(directory, 'missing-one.agdb');
      const missingTwo = join(directory, 'missing-two.agdb');
      try {
        const errors = validateDbSpecs([
          { dbId: 'bad id', dbPath: invalidPath },
          { dbId: 'same', dbPath: missingOne },
          { dbId: 'same', dbPath: missingTwo },
        ]);

        expect(errors).toEqual([
          {
            dbId: 'bad id',
            reason: 'Invalid dbId "bad id": must match [a-zA-Z0-9_-]',
          },
          {
            dbId: 'bad id',
            reason: `Path "${invalidPath}" must be an .agdb file (aira-graphdb only)`,
          },
          { dbId: 'bad id', reason: `Path "${invalidPath}" does not exist` },
          { dbId: 'same', reason: `Path "${missingOne}" does not exist` },
          { dbId: 'same', reason: 'Duplicate dbId "same"' },
          { dbId: 'same', reason: `Path "${missingTwo}" does not exist` },
        ]);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it('allows a non-existent agdb path when path checking is explicitly disabled', () => {
      expect(validateDbSpecs([
        { dbId: 'remote', dbPath: '/future/remote.agdb' },
      ], false)).toEqual([]);
    });
  });

  describe('dictionary context enrichment', () => {
    it('filters by confidence, sorts by confidence, and caps hints at five', async () => {
      const DictionaryContextEnricher = await loadDictionaryContextEnricher();
      const dictionary = makeDictionary([
        makeDictionaryMatch('low', 0.69),
        makeDictionaryMatch('third', 0.85),
        makeDictionaryMatch('first', 0.95),
        makeDictionaryMatch('fifth', 0.75),
        makeDictionaryMatch('second', 0.9),
        makeDictionaryMatch('fourth', 0.8),
        makeDictionaryMatch('sixth', 0.7),
      ]);
      const enricher = new DictionaryContextEnricher(dictionary, 'ja');

      const hints = await enricher.getHints('query text');

      expect(dictionary.match).toHaveBeenCalledWith('query text', 'ja');
      expect(hints.map((hint) => hint.term)).toEqual([
        'first', 'second', 'third', 'fourth', 'fifth',
      ]);
      expect(hints[0]).toMatchObject({
        canonicalForm: 'Canonical first',
        aliases: [],
        category: 'science',
      });
    });

    it('formats aliases and categories while handling empty fields', async () => {
      const DictionaryContextEnricher = await loadDictionaryContextEnricher();
      const enricher = new DictionaryContextEnricher(makeDictionary([]));
      const hints = [
        {
          term: 'matched',
          canonicalForm: 'Canonical term',
          aliases: ['Alias 1', 'Alias 2', 'Alias 3', 'Alias 4'],
          category: 'biology',
        },
        {
          term: 'bare',
          canonicalForm: 'Bare term',
          aliases: [],
          category: '',
        },
      ] as const;

      expect(enricher.formatHints([])).toBe('');
      expect(enricher.formatHints(hints)).toBe(
        '\n[Entity Reference]\n'
        + '• Canonical term (also known as: Alias 1, Alias 2, Alias 3) [biology]\n'
        + '• Bare term\n',
      );
    });

    it('enriches a query in one call and preserves an empty result', async () => {
      const DictionaryContextEnricher = await loadDictionaryContextEnricher();
      const empty = new DictionaryContextEnricher(makeDictionary([]));
      await expect(empty.enrich('nothing')).resolves.toBe('');

      const dictionary = makeDictionary([
        makeDictionaryMatch('term', 0.9, ['alias'], 'physics'),
      ]);
      const enricher = new DictionaryContextEnricher(dictionary);
      await expect(enricher.enrich('term')).resolves.toContain('[Entity Reference]');
    });
  });

  describe('SQLite graph projection', () => {
    const edge = (edgeId: string, sourceNodeId: string, targetNodeId: string): GraphEdge => ({
      edgeId,
      corpusId: 'c1',
      sourceNodeId,
      targetNodeId,
      relation: 'fact_evidence',
      weight: 1,
    });

    const node = (nodeId: string): GraphNode => ({
      nodeId,
      corpusId: 'c1',
      layer: 'fact',
      ref: {},
      label: nodeId,
    });

    it('projects only non-entity transitions and retains weights', async () => {
      const edges = [
        edge('keep', 'fact:f1', 'passage:p1'),
        edge('source-entity', 'entity:e1', 'fact:f1'),
        edge('target-entity', 'fact:f1', 'entity:e1'),
        edge('both-entity', 'entity:e1', 'entity:e2'),
      ];
      const graphStore = {
        getEdges: vi.fn().mockResolvedValue(edges),
      } as unknown as IGraphStore;
      const projection = new SQLiteGraphProjection(graphStore);

      const transitions = [];
      for await (const transition of projection.getTransitions('c1')) {
        transitions.push(transition);
      }

      expect(graphStore.getEdges).toHaveBeenCalledWith('c1');
      expect(transitions).toEqual([
        { sourceNodeId: 'fact:f1', targetNodeId: 'passage:p1', weight: 1 },
      ]);
    });

    it('finds dangling nodes and counts all nodes in the corpus', async () => {
      const nodes = [node('n1'), node('n2'), node('n3')];
      const graphStore = {
        getNodes: vi.fn().mockResolvedValue(nodes),
        getEdges: vi.fn().mockResolvedValue([
          edge('e1', 'n1', 'n2'),
          edge('e2', 'n1', 'n3'),
        ]),
      } as unknown as IGraphStore;
      const projection = new SQLiteGraphProjection(graphStore);

      await expect(projection.getDanglingNodes('c1')).resolves.toEqual(['n2', 'n3']);
      await expect(projection.getNodeCount('c1')).resolves.toBe(3);
      expect(graphStore.getNodes).toHaveBeenNthCalledWith(1, 'c1');
      expect(graphStore.getNodes).toHaveBeenNthCalledWith(2, 'c1');
      expect(graphStore.getEdges).toHaveBeenCalledWith('c1');
    });
  });
});
