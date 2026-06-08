import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { SQLiteLexiconStore } from '../../../../src/infrastructure/storage/SQLiteLexiconStore.js';
import { openDatabase, runMigrations } from '../../../../src/infrastructure/storage/migrate.js';
import type { TermDictionaryEntry } from '../../../../src/domain/dictionary/termDictionary.js';
import type { ThesaurusRelation } from '../../../../src/domain/dictionary/thesaurus.js';

const CORPUS_A = 'corpus-a';
const CORPUS_B = 'corpus-b';
const TIMESTAMP = '2025-01-01T00:00:00.000Z';

function createEntry(termId: string, term: string, canonicalForm = term): TermDictionaryEntry {
  return {
    termId,
    term,
    canonicalForm,
    domainCategory: 'biology',
    aliases: canonicalForm === term ? [] : [term],
    frequency: 4,
    confidence: 0.9,
    source: 'manual',
    version: '1',
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

function createRelation(): ThesaurusRelation {
  return {
    relationId: 'rel-1',
    sourceTerm: 'p53',
    targetTerm: 'TP53',
    relationType: 'synonym',
    language: 'en',
    weight: 1,
    bidirectional: true,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

describe('TASK-MG-021: SQLiteLexiconStore integration', () => {
  let db: Database.Database;
  let storeA: SQLiteLexiconStore;
  let storeB: SQLiteLexiconStore;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db);
    db.prepare(
      'INSERT INTO corpora (corpus_id, name, description) VALUES (?, ?, ?)',
    ).run(CORPUS_A, 'Corpus A', 'Dictionary corpus A');
    db.prepare(
      'INSERT INTO corpora (corpus_id, name, description) VALUES (?, ?, ?)',
    ).run(CORPUS_B, 'Corpus B', 'Dictionary corpus B');
    storeA = new SQLiteLexiconStore(db, CORPUS_A);
    storeB = new SQLiteLexiconStore(db, CORPUS_B);
  });

  afterEach(() => {
    db.close();
  });

  it('supports dictionary CRUD, matching, suggestions, and statistics', async () => {
    await storeA.upsertEntries([
      createEntry('term-1', 'TP53'),
      createEntry('term-2', 'tumor protein p53', 'TP53'),
    ]);

    const matches = await storeA.match('TP53 regulates apoptosis.', 'en');
    const suggestions = await storeA.suggest(['graph rag', 'graph rag', 'tp53'], 2);
    const statistics = await storeA.getStatistics();

    expect(matches.map((match) => match.entry.termId)).toEqual(['term-1', 'term-2']);
    expect(suggestions).toEqual([
      expect.objectContaining({ term: 'graph rag', frequency: 2 }),
    ]);
    expect(statistics).toMatchObject({
      totalTerms: 2,
      discoveredTermCount: 2,
      domains: { biology: 2 },
    });
  });

  it('normalizes and expands queries through thesaurus relations', async () => {
    await storeA.importJson({
      thesaurusRelations: [
        createRelation(),
        {
          relationId: 'rel-2',
          sourceTerm: 'gene',
          targetTerm: 'genetic',
          relationType: 'related',
          language: 'en',
          weight: 0.7,
          bidirectional: true,
          createdAt: TIMESTAMP,
          updatedAt: TIMESTAMP,
        },
      ],
    });

    const normalized = await storeA.normalize('p53', 'en');
    const expanded = await storeA.expandQuery('gene p53', 3);
    const relations = await storeA.getRelations('TP53');
    const suggestions = await storeA.suggestSynonyms([
      ['knowledge graph', 'graph knowledge'],
    ]);

    expect(normalized).toEqual({
      originalTerm: 'p53',
      canonicalTerm: 'TP53',
      appliedRelations: [createRelation()],
    });
    expect(expanded.expandedTerms).toEqual(expect.arrayContaining(['genetic', 'TP53']));
    expect(relations).toEqual([createRelation()]);
    expect(suggestions).toEqual([
      expect.objectContaining({
        sourceTerm: 'knowledge graph',
        targetTerm: 'graph knowledge',
        relationType: 'synonym',
      }),
    ]);
  });

  it('isolates dictionary and thesaurus data per corpus', async () => {
    await storeA.upsertEntries([createEntry('term-a', 'TP53')]);
    await storeB.upsertEntries([createEntry('term-b', 'BERT')]);
    await storeA.importJson({ thesaurusRelations: [createRelation()] });
    await storeB.importJson({
      thesaurusRelations: [
        {
          ...createRelation(),
          relationId: 'rel-b',
          sourceTerm: 'transformer',
          targetTerm: 'BERT',
        },
      ],
    });

    const corpusAMatches = await storeA.match('TP53 expression', 'en');
    const corpusBMatches = await storeB.match('TP53 expression', 'en');
    const corpusARelations = await storeA.getRelations('TP53');
    const corpusBRelations = await storeB.getRelations('TP53');

    expect(corpusAMatches).toHaveLength(1);
    expect(corpusBMatches).toHaveLength(0);
    expect(corpusARelations).toHaveLength(1);
    expect(corpusBRelations).toHaveLength(0);
  });

  it('round-trips export and import without destructive merge', async () => {
    await storeA.upsertEntries([createEntry('term-1', 'TP53')]);
    await storeA.importJson({
      thesaurusRelations: [createRelation()],
      dictionaryCandidates: [
        {
          candidate_id: 'cand-1',
          term: 'graph rag',
          frequency: 3,
          confidence: 0.75,
          source: 'extracted',
          created_at: TIMESTAMP,
        },
      ],
    });

    const exported = await storeA.exportJson();
    await storeB.importJson(exported);

    const importedMatches = await storeB.match('TP53 mutation', 'en');
    const importedRelations = await storeB.getRelations('TP53');
    const importedStats = await storeB.getStatistics();

    expect(importedMatches).toHaveLength(1);
    expect(importedRelations).toEqual([createRelation()]);
    expect(importedStats.discoveredTermCount).toBe(1);
  });
});
