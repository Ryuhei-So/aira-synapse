import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { SQLiteLexiconStore } from '../../../../src/infrastructure/storage/SQLiteLexiconStore.js';
import { openDatabase, runMigrations } from '../../../../src/infrastructure/storage/migrate.js';
import type { TermDictionaryEntry } from '../../../../src/domain/dictionary/termDictionary.js';

const CORPUS = 'corpus-x';
const TIMESTAMP = '2025-01-01T00:00:00.000Z';

function entry(termId: string, term: string, canonicalForm: string, aliases: readonly string[], frequency = 1, confidence = 0.9): TermDictionaryEntry {
  return { termId, term, canonicalForm, domainCategory: 'biology', aliases, frequency, confidence, source: 'manual', version: '1', createdAt: TIMESTAMP, updatedAt: TIMESTAMP };
}

/** The pre-index implementation, row for row, used as the oracle. */
function referenceMatch(db: Database.Database, corpusId: string, text: string) {
  const rows = db.prepare(
    `SELECT term_id, term, canonical_form, aliases_json FROM term_dictionary WHERE corpus_id = ? ORDER BY frequency DESC, confidence DESC, term`,
  ).all(corpusId) as { term_id: string; term: string; canonical_form: string; aliases_json: string }[];
  const haystack = text.trim().toLowerCase();
  const out: { termId: string; matchedText: string }[] = [];
  for (const row of rows) {
    const candidates = [row.term, row.canonical_form, ...(JSON.parse(row.aliases_json) as string[])];
    const matched = candidates.find((candidate) => SQLiteLexiconStore.candidateMatches(haystack, candidate));
    if (matched !== undefined) out.push({ termId: row.term_id, matchedText: matched });
  }
  return out;
}

// Deterministic generator: terms with hyphens, underscores, digits, punctuation, multi-word,
// unicode, leading/trailing non-word characters and whitespace-only aliases.
function pseudoRandom(seed: number) {
  let state = seed >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 0x100000000; };
}
const PIECES = ['p53', 'tp53', 'covid-19', 'sars_cov_2', 'β-catenin', 'il-6', 'x', 'alpha', 'beta', 'gut', 'microbiome', '(mdd)', 'major', 'depressive', 'disorder', 'k+', 'na+/k+', '2', '19', 'e.coli', 'γ', '_id', 'a', 'ab', 'abc'];
function randomTerm(next: () => number): string {
  const n = 1 + Math.floor(next() * 3);
  return Array.from({ length: n }, () => PIECES[Math.floor(next() * PIECES.length)]!).join(next() < 0.5 ? ' ' : '-');
}

describe('SQLiteLexiconStore match index', () => {
  let dir: string;
  let db: Database.Database;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lexicon-index-'));
    db = openDatabase(join(dir, 'lexicon.sqlite'));
    runMigrations(db);
    db.prepare('INSERT OR IGNORE INTO corpora (corpus_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(CORPUS, CORPUS, TIMESTAMP, TIMESTAMP);
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it('reproduces the regex predicate row for row on generated dictionaries and queries', async () => {
    const next = pseudoRandom(42);
    const entries: TermDictionaryEntry[] = [];
    for (let i = 0; i < 300; i++) {
      const aliases = Array.from({ length: Math.floor(next() * 3) }, () => randomTerm(next));
      if (i % 37 === 0) aliases.push('   ');
      if (i % 41 === 0) aliases.push('');
      entries.push(entry(`t${i}`, randomTerm(next), randomTerm(next), aliases, Math.floor(next() * 12), 0.5 + next() / 2));
    }
    const store = new SQLiteLexiconStore(db, CORPUS);
    await store.upsertEntries(entries);
    const queries = [
      '', '   ', 'p53', 'TP53 and p53 in COVID-19 patients', 'the gut microbiome (MDD) major depressive disorder',
      'SARS_CoV_2 il-6 β-catenin na+/k+ e.coli', 'xabc ab a', '--covid-19--', 'k+ 2 19 _id',
      ...Array.from({ length: 60 }, () => Array.from({ length: 1 + Math.floor(next() * 12) }, () => randomTerm(next)).join(next() < 0.3 ? ', ' : ' ')),
    ];
    for (const query of queries) {
      const indexed = (await store.match(query, 'en')).map((m) => ({ termId: m.entry.termId, matchedText: m.matchedText }));
      expect(indexed, JSON.stringify(query)).toEqual(referenceMatch(db, CORPUS, query));
    }
  });

  it('serves repeated queries from the index and drops it after a local write or a foreign commit', async () => {
    const store = new SQLiteLexiconStore(db, CORPUS);
    await store.upsertEntries([entry('t1', 'p53', 'TP53', ['tumor protein 53'], 5)]);
    expect((await store.match('tp53 pathway', 'en')).map((m) => m.matchedText)).toEqual(['TP53']);
    expect((await store.match('tumor protein 53 pathway', 'en')).map((m) => m.matchedText)).toEqual(['tumor protein 53']);

    // A second store on the same connection shares the index and sees this connection's write.
    const sibling = new SQLiteLexiconStore(db, CORPUS);
    await sibling.upsertEntries([entry('t2', 'il-6', 'interleukin 6', [], 9)]);
    expect((await store.match('il-6 and tp53', 'en')).map((m) => m.entry.termId)).toEqual(['t2', 't1']);

    // A write through another connection is detected via PRAGMA data_version.
    const other = openDatabase(join(dir, 'lexicon.sqlite'));
    try {
      await new SQLiteLexiconStore(other, CORPUS).upsertEntries([entry('t3', 'covid-19', 'COVID-19', [], 20)]);
    } finally { other.close(); }
    expect((await store.match('covid-19 il-6 tp53', 'en')).map((m) => m.entry.termId)).toEqual(['t3', 't2', 't1']);
  });

  it('keeps corpora isolated inside the shared index', async () => {
    await new SQLiteLexiconStore(db, CORPUS).upsertEntries([entry('a', 'alpha', 'alpha', [])]);
    db.prepare('INSERT OR IGNORE INTO corpora (corpus_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run('other', 'other', TIMESTAMP, TIMESTAMP);
    await new SQLiteLexiconStore(db, 'other').upsertEntries([entry('b', 'beta', 'beta', [])]);
    expect((await new SQLiteLexiconStore(db, CORPUS).match('alpha beta', 'en')).map((m) => m.entry.termId)).toEqual(['a']);
    expect((await new SQLiteLexiconStore(db, 'other').match('alpha beta', 'en')).map((m) => m.entry.termId)).toEqual(['b']);
  });
});
