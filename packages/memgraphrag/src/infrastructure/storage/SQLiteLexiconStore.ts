/**
 * Infrastructure Layer — SQLite-backed term dictionary and thesaurus adapter.
 * DES-MG-023, DES-MG-024, DES-MG-030: Corpus-scoped lexicon persistence.
 */

import type Database from 'better-sqlite3';
import type {
  DictionaryMatch,
  DictionaryStatistics,
  ITermDictionary,
  TermDictionaryEntry,
} from '../../domain/dictionary/termDictionary.js';
import type {
  IThesaurus,
  NormalizationResult,
  QueryExpansion,
  ThesaurusRelation,
  ThesaurusRelationType,
} from '../../domain/dictionary/thesaurus.js';
import type { LanguageCode } from '../../domain/memory/types.js';

interface TermDictionaryRow {
  readonly term_id: string;
  readonly term: string;
  readonly canonical_form: string;
  readonly domain_category: string;
  readonly aliases_json: string;
  readonly frequency: number;
  readonly confidence: number;
  readonly source: TermDictionaryEntry['source'];
  readonly version: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface CandidateRow {
  readonly candidate_id: string;
  readonly term: string;
  readonly frequency: number;
  readonly confidence: number;
  readonly source: string;
  readonly created_at: string;
}

interface ThesaurusRelationRow {
  readonly relation_id: string;
  readonly source_term: string;
  readonly target_term: string;
  readonly relation_type: ThesaurusRelationType;
  readonly language: LanguageCode;
  readonly weight: number;
  readonly bidirectional: number;
  readonly created_at: string;
  readonly updated_at: string;
}

function parseJsonArray<T>(value: string): readonly T[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? (parsed as readonly T[]) : [];
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Dictionary match index (literature-hub #575).
 *
 * `match()` used to build one RegExp per term (and per alias) for every row of
 * the corpus dictionary on every call: ~250k regexes per query, twice per
 * retrieval, several seconds of CPU. The index below is the same predicate
 * evaluated the other way round: a `\bX\b` test succeeds exactly when X is a
 * substring of the haystack that starts and ends on an ASCII word boundary
 * (JavaScript `\b` without the `u` flag), so the query enumerates its
 * boundary-delimited substrings once and looks each up in a map of normalized
 * candidates. Row order, first-matching-candidate order and matchedText are
 * unchanged.
 *
 * The index is shared by every store instance on the same connection (the
 * runtime constructs a store per request) and is dropped when this connection
 * writes the dictionary or when SQLite reports that another connection
 * committed (`PRAGMA data_version`).
 */
interface LexiconMatchIndex {
  readonly dataVersion: number;
  readonly rows: readonly TermDictionaryRow[];
  /** Raw candidates per row in [term, canonicalForm, ...aliases] order. */
  readonly candidates: readonly (readonly string[])[];
  /** Normalized candidates aligned with `candidates`. */
  readonly normalized: readonly (readonly string[])[];
  /** normalized candidate -> row indices that carry it. */
  readonly byCandidate: ReadonlyMap<string, readonly number[]>;
  /** Rows carrying an empty normalized candidate (`\b\b`: matches any boundary). */
  readonly emptyCandidateRows: readonly number[];
  readonly maxCandidateLength: number;
}

const lexiconMatchIndexes = new WeakMap<Database.Database, Map<string, LexiconMatchIndex>>();

function isAsciiWordChar(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}

/** Positions p in [0, text.length] where JavaScript `\b` holds. */
function wordBoundaries(text: string): number[] {
  const boundaries: number[] = [];
  let previous = false;
  for (let p = 0; p <= text.length; p++) {
    const current = p < text.length && isAsciiWordChar(text.charCodeAt(p));
    if (current !== previous) boundaries.push(p);
    previous = current;
  }
  return boundaries;
}

function buildLexiconMatchIndex(rows: readonly TermDictionaryRow[], dataVersion: number): LexiconMatchIndex {
  const candidates: (readonly string[])[] = [];
  const normalized: (readonly string[])[] = [];
  const byCandidate = new Map<string, number[]>();
  const emptyCandidateRows: number[] = [];
  let maxCandidateLength = 0;
  rows.forEach((row, index) => {
    const raw = [row.term, row.canonical_form, ...parseJsonArray<string>(row.aliases_json)];
    const forms = raw.map((candidate) => normalizeText(String(candidate)));
    candidates.push(raw);
    normalized.push(forms);
    let hasEmpty = false;
    for (const form of forms) {
      if (form === '') { hasEmpty = true; continue; }
      if (form.length > maxCandidateLength) maxCandidateLength = form.length;
      const owners = byCandidate.get(form);
      if (owners) { if (owners[owners.length - 1] !== index) owners.push(index); }
      else byCandidate.set(form, [index]);
    }
    if (hasEmpty) emptyCandidateRows.push(index);
  });
  return { dataVersion, rows, candidates, normalized, byCandidate, emptyCandidateRows, maxCandidateLength };
}

function nowIsoString(): string {
  return new Date().toISOString();
}

function toDictionaryEntry(row: TermDictionaryRow): TermDictionaryEntry {
  return {
    termId: row.term_id,
    term: row.term,
    canonicalForm: row.canonical_form,
    domainCategory: row.domain_category,
    aliases: parseJsonArray<string>(row.aliases_json),
    frequency: row.frequency,
    confidence: row.confidence,
    source: row.source,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toThesaurusRelation(row: ThesaurusRelationRow): ThesaurusRelation {
  return {
    relationId: row.relation_id,
    sourceTerm: row.source_term,
    targetTerm: row.target_term,
    relationType: row.relation_type,
    language: row.language,
    weight: row.weight,
    bidirectional: row.bidirectional === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SQLiteLexiconStore implements ITermDictionary, IThesaurus {
  public constructor(
    private readonly db: Database.Database,
    private readonly corpusId: string,
  ) {}

  public async upsertEntries(entries: readonly TermDictionaryEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }

    const statement = this.db.prepare(
      `INSERT OR REPLACE INTO term_dictionary (
         term_id, corpus_id, term, canonical_form, domain_category, aliases_json,
         frequency, confidence, source, version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const transaction = this.db.transaction((nextEntries: readonly TermDictionaryEntry[]) => {
      for (const entry of nextEntries) {
        statement.run(
          entry.termId,
          this.corpusId,
          entry.term,
          entry.canonicalForm,
          entry.domainCategory,
          JSON.stringify(entry.aliases),
          entry.frequency,
          entry.confidence,
          entry.source,
          entry.version,
          entry.createdAt,
          entry.updatedAt,
        );
      }
    });

    transaction(entries);
    this.invalidateMatchIndex();
  }

  /** Drop this connection's dictionary indexes after a local write. */
  private invalidateMatchIndex(): void {
    lexiconMatchIndexes.delete(this.db);
  }

  private matchIndex(): LexiconMatchIndex {
    const dataVersion = Number(this.db.pragma('data_version', { simple: true }));
    let perCorpus = lexiconMatchIndexes.get(this.db);
    const cached = perCorpus?.get(this.corpusId);
    if (cached && cached.dataVersion === dataVersion) return cached;
    const rows = this.db.prepare(
      `SELECT term_id, term, canonical_form, domain_category, aliases_json, frequency,
              confidence, source, version, created_at, updated_at
       FROM term_dictionary
       WHERE corpus_id = ?
       ORDER BY frequency DESC, confidence DESC, term`,
    ).all(this.corpusId) as TermDictionaryRow[];
    const index = buildLexiconMatchIndex(rows, dataVersion);
    if (!perCorpus) {
      perCorpus = new Map();
      lexiconMatchIndexes.set(this.db, perCorpus);
    }
    perCorpus.set(this.corpusId, index);
    return index;
  }

  /**
   * Reference predicate the index reproduces; kept for tests and as executable
   * documentation of the matching rule.
   */
  public static candidateMatches(haystack: string, candidate: string): boolean {
    return new RegExp(`\\b${escapeRegex(normalizeText(candidate))}\\b`).test(haystack);
  }

  public async match(
    text: string,
    _language: LanguageCode,
  ): Promise<readonly DictionaryMatch[]> {
    const index = this.matchIndex();
    const haystack = normalizeText(text);
    const boundaries = wordBoundaries(haystack);

    // Every boundary-delimited substring the regex form could have matched.
    const present = new Set<string>();
    for (let a = 0; a < boundaries.length; a++) {
      const start = boundaries[a]!;
      for (let b = a + 1; b < boundaries.length; b++) {
        const end = boundaries[b]!;
        if (end - start > index.maxCandidateLength) break;
        present.add(haystack.slice(start, end));
      }
    }

    const matchedRows = new Set<number>(boundaries.length > 0 ? index.emptyCandidateRows : []);
    for (const substring of present) {
      const owners = index.byCandidate.get(substring);
      if (owners) for (const row of owners) matchedRows.add(row);
    }

    const matches: DictionaryMatch[] = [];
    for (const rowIndex of [...matchedRows].sort((left, right) => left - right)) {
      const forms = index.normalized[rowIndex]!;
      const position = forms.findIndex((form) => (form === '' ? boundaries.length > 0 : present.has(form)));
      if (position === -1) continue;
      const entry = toDictionaryEntry(index.rows[rowIndex]!);
      matches.push({
        entry,
        matchedText: index.candidates[rowIndex]![position]!,
        boostFactor: 1 + entry.confidence + Math.min(entry.frequency, 10) / 10,
      });
    }

    return matches;
  }

  public async suggest(
    entries: readonly string[],
    frequencyThreshold: number,
  ): Promise<readonly TermDictionaryEntry[]> {
    if (entries.length === 0) {
      return [];
    }

    const counts = new Map<string, number>();
    for (const entry of entries) {
      const normalized = entry.trim();
      if (!normalized) {
        continue;
      }
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    }

    const now = nowIsoString();
    const upsertCandidate = this.db.prepare(
      `INSERT INTO dictionary_candidates (
         candidate_id, corpus_id, term, frequency, confidence, source, status, created_at
       ) VALUES (?, ?, ?, ?, ?, 'extracted', 'pending', ?)
       ON CONFLICT(candidate_id) DO UPDATE SET
         frequency = dictionary_candidates.frequency + excluded.frequency,
         confidence = MAX(dictionary_candidates.confidence, excluded.confidence)`,
    );

    const transaction = this.db.transaction(() => {
      for (const [term, frequency] of counts) {
        upsertCandidate.run(
          `${this.corpusId}:${term}`,
          this.corpusId,
          term,
          frequency,
          Math.min(1, frequency / Math.max(frequencyThreshold, 1)),
          now,
        );
      }
    });
    transaction();

    const rows = this.db.prepare(
      `SELECT candidate_id, term, frequency, confidence, source, created_at
       FROM dictionary_candidates
       WHERE corpus_id = ? AND frequency >= ? AND status = 'pending'
       ORDER BY frequency DESC, term`,
    ).all(this.corpusId, frequencyThreshold) as CandidateRow[];

    return rows.map((row) => ({
      termId: `candidate:${row.candidate_id}`,
      term: row.term,
      canonicalForm: row.term,
      domainCategory: 'suggested',
      aliases: [],
      frequency: row.frequency,
      confidence: row.confidence,
      source: 'extracted',
      version: 'candidate',
      createdAt: row.created_at,
      updatedAt: now,
    }));
  }

  public async exportJson(): Promise<Readonly<Record<string, unknown>>> {
    const entries = this.db.prepare(
      `SELECT term_id, term, canonical_form, domain_category, aliases_json, frequency,
              confidence, source, version, created_at, updated_at
       FROM term_dictionary
       WHERE corpus_id = ?
       ORDER BY term_id`,
    ).all(this.corpusId) as TermDictionaryRow[];

    const relations = this.db.prepare(
      `SELECT relation_id, source_term, target_term, relation_type, language, weight,
              bidirectional, created_at, updated_at
       FROM thesaurus_relations
       WHERE corpus_id = ?
       ORDER BY relation_id`,
    ).all(this.corpusId) as ThesaurusRelationRow[];

    const candidates = this.db.prepare(
      `SELECT candidate_id, term, frequency, confidence, source, created_at
       FROM dictionary_candidates
       WHERE corpus_id = ?
       ORDER BY candidate_id`,
    ).all(this.corpusId) as CandidateRow[];

    return {
      corpusId: this.corpusId,
      termDictionary: entries.map(toDictionaryEntry),
      thesaurusRelations: relations.map(toThesaurusRelation),
      dictionaryCandidates: candidates,
    };
  }

  public async importJson(data: Readonly<Record<string, unknown>>): Promise<void> {
    const rawEntries = data['termDictionary'];
    const rawRelations = data['thesaurusRelations'];
    const rawCandidates = data['dictionaryCandidates'];

    const entries = Array.isArray(rawEntries)
      ? (rawEntries as readonly TermDictionaryEntry[])
      : [];
    const relations = Array.isArray(rawRelations)
      ? (rawRelations as readonly ThesaurusRelation[])
      : [];
    const candidates = Array.isArray(rawCandidates)
      ? (rawCandidates as readonly CandidateRow[])
      : [];

    const upsertEntry = this.db.prepare(
      `INSERT OR REPLACE INTO term_dictionary (
         term_id, corpus_id, term, canonical_form, domain_category, aliases_json,
         frequency, confidence, source, version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const upsertRelation = this.db.prepare(
      `INSERT OR REPLACE INTO thesaurus_relations (
         relation_id, corpus_id, source_term, target_term, relation_type, language,
         weight, bidirectional, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const upsertCandidate = this.db.prepare(
      `INSERT OR REPLACE INTO dictionary_candidates (
         candidate_id, corpus_id, term, frequency, confidence, source, status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    );

    const transaction = this.db.transaction(() => {
      for (const entry of entries) {
        upsertEntry.run(
          entry.termId,
          this.corpusId,
          entry.term,
          entry.canonicalForm,
          entry.domainCategory,
          JSON.stringify(entry.aliases),
          entry.frequency,
          entry.confidence,
          entry.source,
          entry.version,
          entry.createdAt,
          entry.updatedAt,
        );
      }

      for (const relation of relations) {
        upsertRelation.run(
          relation.relationId,
          this.corpusId,
          relation.sourceTerm,
          relation.targetTerm,
          relation.relationType,
          relation.language,
          relation.weight,
          relation.bidirectional ? 1 : 0,
          relation.createdAt,
          relation.updatedAt,
        );
      }

      for (const candidate of candidates) {
        upsertCandidate.run(
          candidate.candidate_id,
          this.corpusId,
          candidate.term,
          candidate.frequency,
          candidate.confidence,
          candidate.source,
          candidate.created_at,
        );
      }
    });

    transaction();
    this.invalidateMatchIndex();
  }

  public async getStatistics(): Promise<DictionaryStatistics> {
    const totals = this.db.prepare(
      `SELECT COUNT(*) AS total_terms,
              COALESCE(SUM(CASE WHEN confidence >= 0.5 THEN 1 ELSE 0 END), 0) AS boosted_terms
       FROM term_dictionary
       WHERE corpus_id = ?`,
    ).get(this.corpusId) as { total_terms: number; boosted_terms: number };

    const domainRows = this.db.prepare(
      `SELECT domain_category, COUNT(*) AS count
       FROM term_dictionary
       WHERE corpus_id = ?
       GROUP BY domain_category`,
    ).all(this.corpusId) as { domain_category: string; count: number }[];

    const candidateCount = this.db.prepare(
      `SELECT COUNT(*) AS count
       FROM dictionary_candidates
       WHERE corpus_id = ?`,
    ).get(this.corpusId) as { count: number };

    const domains: Record<string, number> = {};
    for (const row of domainRows) {
      domains[row.domain_category] = row.count;
    }

    return {
      totalTerms: totals.total_terms,
      domains,
      boostAppliedRate:
        totals.total_terms === 0 ? 0 : totals.boosted_terms / totals.total_terms,
      discoveredTermCount: candidateCount.count,
    };
  }

  public async normalize(
    term: string,
    language: LanguageCode,
  ): Promise<NormalizationResult> {
    const dictionaryMatch = this.db.prepare(
      `SELECT canonical_form
       FROM term_dictionary
       WHERE corpus_id = ? AND (LOWER(term) = LOWER(?) OR LOWER(canonical_form) = LOWER(?))
       ORDER BY term_id
       LIMIT 1`,
    ).get(this.corpusId, term, term) as { canonical_form: string } | undefined;

    const synonymRows = this.db.prepare(
      `SELECT relation_id, source_term, target_term, relation_type, language, weight,
              bidirectional, created_at, updated_at
       FROM thesaurus_relations
       WHERE corpus_id = ?
         AND language = ?
         AND relation_type = 'synonym'
         AND (LOWER(source_term) = LOWER(?) OR LOWER(target_term) = LOWER(?))
       ORDER BY weight DESC, relation_id`,
    ).all(this.corpusId, language, term, term) as ThesaurusRelationRow[];

    const relations = synonymRows.map(toThesaurusRelation);
    const canonicalTerm = dictionaryMatch?.canonical_form
      ?? relations[0]?.targetTerm
      ?? relations[0]?.sourceTerm
      ?? term;

    return {
      canonicalTerm,
      originalTerm: term,
      appliedRelations: relations,
    };
  }

  public async expandQuery(
    query: string,
    limit: number,
  ): Promise<QueryExpansion> {
    const tokens = query
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 0);

    if (tokens.length === 0 || limit <= 0) {
      return {
        originalQuery: query,
        expandedTerms: [],
        rewrittenQuery: query,
      };
    }

    const placeholders = tokens.map(() => '?').join(', ');
    const rows = this.db.prepare(
      `SELECT relation_id, source_term, target_term, relation_type, language, weight,
              bidirectional, created_at, updated_at
       FROM thesaurus_relations
       WHERE corpus_id = ?
         AND (
           LOWER(source_term) IN (${placeholders})
           OR LOWER(target_term) IN (${placeholders})
         )
       ORDER BY weight DESC, relation_id`,
    ).all(
      this.corpusId,
      ...tokens.map(normalizeText),
      ...tokens.map(normalizeText),
    ) as ThesaurusRelationRow[];

    const expandedTerms: string[] = [];
    for (const relation of rows) {
      const related = tokens.some((token) => normalizeText(token) === normalizeText(relation.source_term))
        ? relation.target_term
        : relation.source_term;
      if (
        tokens.some((token) => normalizeText(token) === normalizeText(related))
        || expandedTerms.some((term) => normalizeText(term) === normalizeText(related))
      ) {
        continue;
      }
      expandedTerms.push(related);
      if (expandedTerms.length >= limit) {
        break;
      }
    }

    return {
      originalQuery: query,
      expandedTerms,
      rewrittenQuery:
        expandedTerms.length === 0 ? query : `${query} ${expandedTerms.join(' ')}`,
    };
  }

  public async getRelations(term: string): Promise<readonly ThesaurusRelation[]> {
    const rows = this.db.prepare(
      `SELECT relation_id, source_term, target_term, relation_type, language, weight,
              bidirectional, created_at, updated_at
       FROM thesaurus_relations
       WHERE corpus_id = ?
         AND (LOWER(source_term) = LOWER(?) OR LOWER(target_term) = LOWER(?))
       ORDER BY weight DESC, relation_id`,
    ).all(this.corpusId, term, term) as ThesaurusRelationRow[];

    return rows.map(toThesaurusRelation);
  }

  public async suggestSynonyms(
    pairs: readonly [string, string][],
  ): Promise<readonly ThesaurusRelation[]> {
    const now = nowIsoString();
    const suggestions: ThesaurusRelation[] = [];

    for (const [sourceTerm, targetTerm] of pairs) {
      if (!sourceTerm.trim() || !targetTerm.trim()) {
        continue;
      }
      suggestions.push({
        relationId: `suggested:${normalizeText(sourceTerm)}:${normalizeText(targetTerm)}`,
        sourceTerm,
        targetTerm,
        relationType: 'synonym',
        language: 'unknown',
        weight: 1,
        bidirectional: true,
        createdAt: now,
        updatedAt: now,
      });
    }

    return suggestions;
  }
}
