import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import type { Fact } from '../../../../src/domain/memory/fact.js';
import type { Passage } from '../../../../src/domain/memory/passage.js';
import { LexiconBuilder } from '../../../../src/application/indexing/LexiconBuilder.js';
import { SQLiteLexiconStore } from '../../../../src/infrastructure/storage/SQLiteLexiconStore.js';
import { openDatabase, runMigrations } from '../../../../src/infrastructure/storage/migrate.js';

const NOW = '2026-06-15T00:00:00.000Z';

interface DictionaryRow {
  readonly term_id: string;
  readonly term: string;
  readonly canonical_form: string;
  readonly aliases_json: string;
  readonly frequency: number;
}

interface ThesaurusRow {
  readonly source_term: string;
  readonly target_term: string;
  readonly relation_type: string;
}

function createFact(overrides: Partial<Fact> = {}): Fact {
  return {
    factId: 'fact-1',
    corpusId: 'corpus-a',
    schemaId: 'schema-1',
    headEntity: 'TP53',
    headType: 'Gene',
    relation: 'regulates',
    tailEntity: 'Apoptosis',
    tailType: 'Process',
    state: 'active',
    passageIds: ['passage-1'],
    sourceDocumentIds: ['doc-1'],
    confidence: 0.9,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function createPassage(overrides: Partial<Passage> = {}): Passage {
  return {
    passageId: 'passage-1',
    corpusId: 'corpus-a',
    text: 'TP53 regulates apoptosis.',
    normalizedText: 'tp53 regulates apoptosis.',
    metadata: {
      documentId: 'doc-1',
      title: 'Doc 1',
      sourceUrl: 'https://example.com/doc-1',
      language: 'en',
      sectionPath: [],
      chunkId: 'chunk-1',
      chunkIndex: 0,
      offsetStart: 0,
      offsetEnd: 32,
    },
    factIds: ['fact-1'],
    entityMentions: ['TP53', 'Apoptosis'],
    qualityFlags: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function readDictionaryRows(db: Database.Database, corpusId: string): DictionaryRow[] {
  return db.prepare(
    `SELECT term_id, term, canonical_form, aliases_json, frequency
     FROM term_dictionary
     WHERE corpus_id = ?
     ORDER BY term_id`,
  ).all(corpusId) as DictionaryRow[];
}

function readThesaurusRows(db: Database.Database, corpusId: string): ThesaurusRow[] {
  return db.prepare(
    `SELECT source_term, target_term, relation_type
     FROM thesaurus_relations
     WHERE corpus_id = ?
     ORDER BY relation_id`,
  ).all(corpusId) as ThesaurusRow[];
}

describe('T-006: LexiconBuilder', () => {
  let db: Database.Database;
  let builder: LexiconBuilder;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db);
    db.prepare(
      'INSERT INTO corpora (corpus_id, name, description) VALUES (?, ?, ?)',
    ).run('corpus-a', 'Corpus A', 'Primary corpus');
    builder = new LexiconBuilder(
      new SQLiteLexiconStore(db, 'corpus-a'),
      db,
      'corpus-a',
    );
  });

  afterEach(() => {
    db.close();
  });

  it('returns an empty result for an empty document', async () => {
    const result = await builder.buildIncremental('doc-empty', [], []);

    expect(result).toEqual({
      dictionaryEntries: 0,
      thesaurusRelations: 0,
      ambiguousExcluded: 0,
      stopwordExcluded: 0,
    });
    expect(readDictionaryRows(db, 'corpus-a')).toEqual([]);
    expect(readThesaurusRows(db, 'corpus-a')).toEqual([]);
  });

  it('extracts entity frequencies into dictionary entries', async () => {
    const facts = [
      createFact({ factId: 'fact-1', tailEntity: 'Apoptosis' }),
      createFact({ factId: 'fact-2', tailEntity: 'Cell Cycle' }),
    ];

    const result = await builder.buildIncremental('doc-1', facts, [createPassage()]);
    const rows = readDictionaryRows(db, 'corpus-a');

    expect(result.dictionaryEntries).toBe(3);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        term_id: 'lex:corpus-a:tp53',
        term: 'tp53',
        canonical_form: 'TP53',
        frequency: 2,
      }),
      expect.objectContaining({
        term_id: 'lex:corpus-a:apoptosis',
        term: 'apoptosis',
        canonical_form: 'Apoptosis',
        frequency: 1,
      }),
      expect.objectContaining({
        term_id: 'lex:corpus-a:cell cycle',
        term: 'cell cycle',
        canonical_form: 'Cell Cycle',
        frequency: 1,
      }),
    ]));
  });

  it('keeps incremental re-indexing idempotent for the same document', async () => {
    const facts = [createFact()];
    const passages = [createPassage()];

    const first = await builder.buildIncremental('doc-1', facts, passages);
    const second = await builder.buildIncremental('doc-1', facts, passages);
    const tp53 = readDictionaryRows(db, 'corpus-a').find((row) => row.term === 'tp53');
    const evidence = db.prepare(
      `SELECT occurrence_count
       FROM lexicon_evidence
       WHERE corpus_id = ? AND document_id = ? AND entity_normalized = ? AND evidence_type = 'frequency'`,
    ).get('corpus-a', 'doc-1', 'tp53') as { occurrence_count: number } | undefined;

    expect(second).toEqual(first);
    expect(tp53?.frequency).toBe(1);
    expect(evidence?.occurrence_count).toBe(1);
  });

  it('cleans up vanished entities when a document is re-indexed', async () => {
    await builder.buildIncremental(
      'doc-1',
      [
        createFact({ factId: 'fact-1', tailEntity: 'Apoptosis' }),
        createFact({ factId: 'fact-2', headEntity: 'BRCA1', tailEntity: 'DNA Repair' }),
      ],
      [createPassage()],
    );

    const result = await builder.buildIncremental(
      'doc-1',
      [createFact({ factId: 'fact-3', tailEntity: 'Apoptosis' })],
      [createPassage({ factIds: ['fact-3'] })],
    );

    const terms = readDictionaryRows(db, 'corpus-a').map((row) => row.term);
    expect(result.dictionaryEntries).toBe(2);
    expect(terms).toContain('tp53');
    expect(terms).toContain('apoptosis');
    expect(terms).not.toContain('brca1');
    expect(terms).not.toContain('dna repair');
  });

  it('detects aliases from parenthetical apposition patterns', async () => {
    const result = await builder.buildIncremental(
      'doc-1',
      [createFact()],
      [
        createPassage({
          text: 'Tumor protein p53 (TP53) suppresses tumors.',
          normalizedText: 'tumor protein p53 (tp53) suppresses tumors.',
          entityMentions: ['Tumor protein p53', 'TP53'],
        }),
      ],
    );

    const tp53 = readDictionaryRows(db, 'corpus-a').find((row) => row.term === 'tp53');
    const relations = readThesaurusRows(db, 'corpus-a');

    expect(result.thesaurusRelations).toBeGreaterThan(0);
    expect(JSON.parse(tp53?.aliases_json ?? '[]')).toContain('Tumor protein p53');
    expect(relations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source_term: 'TP53',
        target_term: 'Tumor protein p53',
        relation_type: 'synonym',
      }),
    ]));
  });

  it('generates corpus-scoped term identifiers', async () => {
    db.prepare(
      'INSERT INTO corpora (corpus_id, name, description) VALUES (?, ?, ?)',
    ).run('corpus-b', 'Corpus B', 'Secondary corpus');

    const builderB = new LexiconBuilder(
      new SQLiteLexiconStore(db, 'corpus-b'),
      db,
      'corpus-b',
    );

    await builder.buildIncremental('doc-a', [createFact()], [createPassage()]);
    await builderB.buildIncremental(
      'doc-b',
      [createFact({ corpusId: 'corpus-b', sourceDocumentIds: ['doc-b'] })],
      [createPassage({
        corpusId: 'corpus-b',
        passageId: 'passage-b',
        factIds: ['fact-1'],
        metadata: {
          documentId: 'doc-b',
          title: 'Doc B',
          sourceUrl: 'https://example.com/doc-b',
          language: 'en',
          sectionPath: [],
          chunkId: 'chunk-b',
          chunkIndex: 0,
          offsetStart: 0,
          offsetEnd: 32,
        },
      })],
    );

    expect(readDictionaryRows(db, 'corpus-a').map((row) => row.term_id)).toContain(
      'lex:corpus-a:tp53',
    );
    expect(readDictionaryRows(db, 'corpus-b').map((row) => row.term_id)).toContain(
      'lex:corpus-b:tp53',
    );
  });

  it('removes an ambiguous alias from dictionary relations while retaining distinct terms', async () => {
    const result = await builder.buildIncremental(
      'doc-ambiguous',
      [
        createFact({ factId: 'fact-shared', headEntity: 'Shared', tailEntity: 'Target A' }),
        createFact({ factId: 'fact-beta', headEntity: 'Beta', tailEntity: 'Target B' }),
      ],
      [
        createPassage({
          passageId: 'passage-shared',
          text: 'Shared (Alpha) is observed.',
          entityMentions: ['Shared', 'Alpha'],
        }),
        createPassage({
          passageId: 'passage-beta',
          text: 'Beta (Shared) is observed.',
          entityMentions: ['Beta', 'Shared'],
        }),
      ],
    );

    expect(result.ambiguousExcluded).toBeGreaterThan(0);
    expect(readDictionaryRows(db, 'corpus-a').map((row) => row.term)).toEqual(
      expect.arrayContaining(['shared', 'beta']),
    );
    expect(readThesaurusRows(db, 'corpus-a').some(
      (row) => row.source_term === 'Beta' && row.target_term === 'Shared',
    )).toBe(false);
  });
});
