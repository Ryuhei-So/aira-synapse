import type Database from 'better-sqlite3';
import type {
  ITermDictionary,
  TermDictionaryEntry,
} from '../../domain/dictionary/termDictionary.js';
import type { Fact } from '../../domain/memory/fact.js';
import type { Passage } from '../../domain/memory/passage.js';

type EvidenceType =
  | 'frequency'
  | 'alias_apposition'
  | 'alias_parenthetical'
  | 'alias_cooccurrence'
  | 'hypernym';

interface EvidenceInsertSummary {
  readonly stopwordExcluded: number;
}

interface EntityAggregate {
  readonly entity_normalized: string;
  readonly frequency: number;
}

interface DictionaryRow {
  readonly term: string;
  readonly canonical_form: string;
  readonly aliases_json: string;
}

interface EvidenceSurfaceRow {
  readonly surface_form: string;
  readonly frequency: number;
}

interface EvidenceConfidenceRow {
  readonly confidence: number;
}

interface RelatedEvidenceRow {
  readonly entity_normalized: string;
  readonly related_entity: string;
  readonly confidence: number;
}

interface FactBackfillRow {
  readonly fact_id: string;
  readonly schema_id: string;
  readonly head_entity: string;
  readonly head_type: string;
  readonly relation: string;
  readonly tail_entity: string;
  readonly tail_type: string;
  readonly state: Fact['state'];
  readonly confidence: number;
  readonly temporal_scope: string | null;
  readonly granularity_parent_fact_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly document_id: string;
}

interface FactPassageRow {
  readonly fact_id: string;
  readonly passage_id: string;
}

interface PassageBackfillRow {
  readonly passage_id: string;
  readonly corpus_id: string;
  readonly document_id: string;
  readonly text: string;
  readonly normalized_text: string;
  readonly title: string;
  readonly source_url: string;
  readonly doi: string | null;
  readonly source_db: string | null;
  readonly source_type: Passage['metadata']['sourceType'] | null;
  readonly language: Passage['metadata']['language'];
  readonly converted_at: string | null;
  readonly section_path: string;
  readonly chunk_id: string;
  readonly chunk_index: number;
  readonly offset_start: number;
  readonly offset_end: number;
  readonly entity_mentions: string;
  readonly quality_flags: string;
  readonly quality_score: number | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface LexiconBuildResult {
  readonly dictionaryEntries: number;
  readonly thesaurusRelations: number;
  readonly ambiguousExcluded: number;
  readonly stopwordExcluded: number;
}

function nowIsoString(): string {
  return new Date().toISOString();
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, ' ');
}

function parseJsonArray<T>(value: string): readonly T[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? (parsed as readonly T[]) : [];
}

function tokenize(value: string): ReadonlySet<string> {
  const normalized = normalizeText(value);
  if (!normalized) {
    return new Set();
  }
  return new Set(
    normalized
      .split(/[^\p{L}\p{N}]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length > 0),
  );
}

function jaccardSimilarity(left: string, right: string): number {
  const leftTokens = tokenize(left);
  const rightTokens = tokenize(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  }

  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union === 0 ? 0 : intersection / union;
}

function canonicalPairKey(left: string, right: string): string {
  return [left, right].sort().join('::');
}

export class LexiconBuilder {
  public constructor(
    private readonly dictionary: ITermDictionary,
    private readonly db: Database.Database,
    private readonly corpusId: string,
  ) {}

  public async buildIncremental(
    documentId: string,
    facts: readonly Fact[],
    passages: readonly Passage[],
  ): Promise<LexiconBuildResult> {
    const transaction = this.db.transaction(() => {
      const oldEntities = this.getEntitiesByDocument(documentId);

      this.db.prepare(
        'DELETE FROM lexicon_evidence WHERE corpus_id = ? AND document_id = ?',
      ).run(this.corpusId, documentId);

      const insertResult = this.insertEvidenceForDocument(documentId, facts, passages);
      const newEntities = this.getEntitiesByDocument(documentId);
      const affectedEntities = new Set([...oldEntities, ...newEntities]);

      const upsertEntries: TermDictionaryEntry[] = [];
      let dictionaryEntries = 0;
      for (const entity of affectedEntities) {
        const evidenceCount = this.getEvidenceCount(entity);
        if (evidenceCount === 0) {
          this.deleteDictionaryEntry(entity);
          continue;
        }

        const entry = this.buildDictionaryEntry(entity);
        if (!entry) {
          this.deleteDictionaryEntry(entity);
          continue;
        }

        upsertEntries.push(entry);
        dictionaryEntries += 1;
      }

      void this.dictionary.upsertEntries(upsertEntries);
      const thesaurusRelations = this.recomputeThesaurusRelations();
      const ambiguousExcluded = this.recomputeAmbiguity();

      return {
        dictionaryEntries,
        thesaurusRelations,
        ambiguousExcluded,
        stopwordExcluded: insertResult.stopwordExcluded,
      } satisfies LexiconBuildResult;
    });

    return transaction();
  }

  public async backfill(): Promise<LexiconBuildResult> {
    const factsByDocument = this.loadFactsForBackfill();
    const passagesByDocument = this.loadPassagesForBackfill();
    const documentIds = new Set([
      ...factsByDocument.keys(),
      ...passagesByDocument.keys(),
    ]);

    const transaction = this.db.transaction(() => {
      this.db.prepare(
        'DELETE FROM lexicon_evidence WHERE corpus_id = ?',
      ).run(this.corpusId);
      this.db.prepare(
        'DELETE FROM term_dictionary WHERE corpus_id = ?',
      ).run(this.corpusId);
      this.db.prepare(
        'DELETE FROM thesaurus_relations WHERE corpus_id = ?',
      ).run(this.corpusId);

      let stopwordExcluded = 0;
      for (const documentId of documentIds) {
        const result = this.insertEvidenceForDocument(
          documentId,
          factsByDocument.get(documentId) ?? [],
          passagesByDocument.get(documentId) ?? [],
        );
        stopwordExcluded = result.stopwordExcluded;
      }

      const entityRows = this.db.prepare(
        `SELECT DISTINCT entity_normalized
         FROM lexicon_evidence
         WHERE corpus_id = ?
         ORDER BY entity_normalized`,
      ).all(this.corpusId) as { entity_normalized: string }[];

      const entries = entityRows
        .map((row) => this.buildDictionaryEntry(row.entity_normalized))
        .filter((entry): entry is TermDictionaryEntry => entry !== null);

      void this.dictionary.upsertEntries(entries);
      const thesaurusRelations = this.recomputeThesaurusRelations();
      const ambiguousExcluded = this.recomputeAmbiguity();

      return {
        dictionaryEntries: entries.length,
        thesaurusRelations,
        ambiguousExcluded,
        stopwordExcluded,
      } satisfies LexiconBuildResult;
    });

    return transaction();
  }

  private getEntitiesByDocument(documentId: string): Set<string> {
    const rows = this.db.prepare(
      `SELECT DISTINCT entity_normalized
       FROM lexicon_evidence
       WHERE corpus_id = ? AND document_id = ?`,
    ).all(this.corpusId, documentId) as { entity_normalized: string }[];

    return new Set(rows.map((row) => row.entity_normalized));
  }

  private getEvidenceCount(entity: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS count
       FROM lexicon_evidence
       WHERE corpus_id = ? AND entity_normalized = ?`,
    ).get(this.corpusId, entity) as { count: number } | undefined;

    return row?.count ?? 0;
  }

  private deleteDictionaryEntry(entity: string): void {
    this.db.prepare(
      'DELETE FROM term_dictionary WHERE corpus_id = ? AND LOWER(term) = LOWER(?)',
    ).run(this.corpusId, entity);
    this.db.prepare(
      `DELETE FROM thesaurus_relations
       WHERE corpus_id = ?
         AND (
           LOWER(source_term) = LOWER(?)
           OR LOWER(target_term) = LOWER(?)
         )`,
    ).run(this.corpusId, entity, entity);
  }

  private buildDictionaryEntry(entity: string): TermDictionaryEntry | null {
    const frequencyRow = this.db.prepare(
      `SELECT COALESCE(SUM(occurrence_count), 0) AS frequency
       FROM lexicon_evidence
       WHERE corpus_id = ? AND entity_normalized = ? AND evidence_type = 'frequency'`,
    ).get(this.corpusId, entity) as { frequency: number } | undefined;

    const surfaceRows = this.db.prepare(
      `SELECT surface_form, SUM(occurrence_count) AS frequency
       FROM lexicon_evidence
       WHERE corpus_id = ?
         AND entity_normalized = ?
         AND evidence_type IN (
           'frequency',
           'alias_apposition',
           'alias_parenthetical',
           'alias_cooccurrence'
         )
       GROUP BY surface_form
       ORDER BY frequency DESC, surface_form`,
    ).all(this.corpusId, entity) as EvidenceSurfaceRow[];

    if (surfaceRows.length === 0) {
      return null;
    }

    const canonicalForm = surfaceRows[0]?.surface_form ?? entity;
    const aliases = surfaceRows
      .map((row) => row.surface_form)
      .filter((surface) => normalizeText(surface) !== normalizeText(canonicalForm));

    const confidenceRow = this.db.prepare(
      `SELECT COALESCE(MAX(confidence), 0.7) AS confidence
       FROM lexicon_evidence
       WHERE corpus_id = ? AND entity_normalized = ?`,
    ).get(this.corpusId, entity) as EvidenceConfidenceRow | undefined;

    const now = nowIsoString();
    return {
      termId: `lex:${this.corpusId}:${entity}`,
      term: entity,
      canonicalForm,
      domainCategory: this.resolveDomainCategory(entity),
      aliases,
      frequency: frequencyRow?.frequency ?? 0,
      confidence: confidenceRow?.confidence ?? 0.7,
      source: 'extracted',
      version: '1',
      createdAt: now,
      updatedAt: now,
    };
  }

  private resolveDomainCategory(entity: string): string {
    const rows = this.db.prepare(
      `SELECT head_type AS entity_type FROM facts
       WHERE corpus_id = ? AND LOWER(head_entity) = LOWER(?)
       UNION ALL
       SELECT tail_type AS entity_type FROM facts
       WHERE corpus_id = ? AND LOWER(tail_entity) = LOWER(?)`,
    ).all(this.corpusId, entity, this.corpusId, entity) as { entity_type: string }[];

    if (rows.length === 0) {
      return 'general';
    }

    const counts = new Map<string, number>();
    for (const row of rows) {
      const type = normalizeText(row.entity_type);
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }

    return [...counts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0]
      ?? 'general';
  }

  private insertEvidenceForDocument(
    documentId: string,
    facts: readonly Fact[],
    passages: readonly Passage[],
  ): EvidenceInsertSummary {
    const entityStats = new Map<
      string,
      { totalCount: number; surfaces: Map<string, number>; types: Set<string> }
    >();
    const surfaceIndex = new Map<string, Set<string>>();

    const registerSurface = (entityNormalized: string, surfaceForm: string): void => {
      const normalizedSurface = normalizeText(surfaceForm);
      if (!normalizedSurface) {
        return;
      }

      const entities = surfaceIndex.get(normalizedSurface) ?? new Set<string>();
      entities.add(entityNormalized);
      surfaceIndex.set(normalizedSurface, entities);
    };

    const registerEntityOccurrence = (
      entity: string,
      surfaceForm: string,
      entityType: string,
    ): void => {
      const entityNormalized = normalizeText(entity);
      if (!entityNormalized) {
        return;
      }

      const next = entityStats.get(entityNormalized) ?? {
        totalCount: 0,
        surfaces: new Map<string, number>(),
        types: new Set<string>(),
      };
      next.totalCount += 1;
      next.surfaces.set(surfaceForm, (next.surfaces.get(surfaceForm) ?? 0) + 1);
      if (entityType.trim()) {
        next.types.add(normalizeText(entityType));
      }
      entityStats.set(entityNormalized, next);
      registerSurface(entityNormalized, surfaceForm);
      registerSurface(entityNormalized, entityNormalized);
    };

    for (const fact of facts) {
      registerEntityOccurrence(fact.headEntity, fact.headEntity, fact.headType);
      registerEntityOccurrence(fact.tailEntity, fact.tailEntity, fact.tailType);
    }

    const insertEvidence = this.db.prepare(
      `INSERT INTO lexicon_evidence (
         corpus_id, document_id, entity_normalized, surface_form, evidence_type,
         related_entity, occurrence_count, confidence, source_passage_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(corpus_id, document_id, entity_normalized, surface_form, evidence_type, related_entity)
       DO UPDATE SET
         occurrence_count = lexicon_evidence.occurrence_count + excluded.occurrence_count,
         confidence = MAX(lexicon_evidence.confidence, excluded.confidence),
         source_passage_id = COALESCE(lexicon_evidence.source_passage_id, excluded.source_passage_id)`,
    );

    const addEvidence = (
      entityNormalized: string,
      surfaceForm: string,
      evidenceType: EvidenceType,
      relatedEntity = '',
      confidence = 0.7,
      sourcePassageId?: string,
      occurrenceCount = 1,
    ): void => {
      if (!entityNormalized || !surfaceForm.trim()) {
        return;
      }
      insertEvidence.run(
        this.corpusId,
        documentId,
        entityNormalized,
        surfaceForm.trim(),
        evidenceType,
        relatedEntity,
        occurrenceCount,
        confidence,
        sourcePassageId ?? null,
      );
    };

    for (const fact of facts) {
      const sourcePassageId = fact.passageIds[0];
      addEvidence(
        normalizeText(fact.headEntity),
        fact.headEntity,
        'frequency',
        '',
        fact.confidence,
        sourcePassageId,
      );
      addEvidence(
        normalizeText(fact.tailEntity),
        fact.tailEntity,
        'frequency',
        '',
        fact.confidence,
        sourcePassageId,
      );
    }

    const resolveEntity = (surfaceForm: string): string | undefined => {
      const normalizedSurface = normalizeText(surfaceForm);
      if (!normalizedSurface) {
        return undefined;
      }

      const direct = entityStats.has(normalizedSurface) ? normalizedSurface : undefined;
      if (direct) {
        return direct;
      }

      const entities = [...(surfaceIndex.get(normalizedSurface) ?? [])];
      if (entities.length === 0) {
        return undefined;
      }

      return entities.sort((left, right) => {
        const leftCount = entityStats.get(left)?.totalCount ?? 0;
        const rightCount = entityStats.get(right)?.totalCount ?? 0;
        return rightCount - leftCount || left.localeCompare(right);
      })[0];
    };

    const choosePrimaryEntity = (left: string, right: string): string => {
      const leftCount = entityStats.get(left)?.totalCount ?? 0;
      const rightCount = entityStats.get(right)?.totalCount ?? 0;
      if (leftCount !== rightCount) {
        return leftCount > rightCount ? left : right;
      }
      return left.localeCompare(right) <= 0 ? left : right;
    };

    const addAliasPair = (
      surfaceA: string,
      surfaceB: string,
      evidenceType: Extract<EvidenceType, 'alias_apposition' | 'alias_parenthetical' | 'alias_cooccurrence'>,
      sourcePassageId: string,
    ): void => {
      const left = surfaceA.trim();
      const right = surfaceB.trim();
      if (!left || !right) {
        return;
      }

      const leftNormalized = normalizeText(left);
      const rightNormalized = normalizeText(right);
      if (!leftNormalized || !rightNormalized || leftNormalized === rightNormalized) {
        return;
      }

      const leftEntity = resolveEntity(left);
      const rightEntity = resolveEntity(right);
      if (!leftEntity && !rightEntity) {
        return;
      }

      const primaryEntity = leftEntity && rightEntity
        ? choosePrimaryEntity(leftEntity, rightEntity)
        : (leftEntity ?? rightEntity);

      if (!primaryEntity) {
        return;
      }

      const relatedEntity = primaryEntity === leftEntity
        ? (rightEntity ?? rightNormalized)
        : (leftEntity ?? leftNormalized);

      addEvidence(primaryEntity, left, evidenceType, relatedEntity, 0.9, sourcePassageId);
      addEvidence(primaryEntity, right, evidenceType, relatedEntity, 0.9, sourcePassageId);
    };

    const addHypernymEvidence = (entitySurface: string, hypernymSurface: string, sourcePassageId: string): void => {
      const entityNormalized = resolveEntity(entitySurface);
      const hypernymNormalized = normalizeText(hypernymSurface);
      if (!entityNormalized || !hypernymNormalized) {
        return;
      }

      addEvidence(
        entityNormalized,
        entitySurface.trim(),
        'hypernym',
        hypernymNormalized,
        0.8,
        sourcePassageId,
      );
    };

    const appositionPattern =
      /([^\n,()]+?)\s*,\s*(?:also known as|a\.k\.a\.|or)\s+([^\n,()]+?)(?=[,.;:]|$)/giu;
    const parentheticalPattern = /([^\n()]+?)\s*\(([^()]+?)\)/gu;
    const hypernymPattern = /([^\n,()]+?)\s*,\s*a[n]?\s+([^\n,.;()]+?)(?=[,.;:]|$)/giu;

    for (const passage of passages) {
      for (const match of passage.text.matchAll(appositionPattern)) {
        const left = match[1]?.trim();
        const right = match[2]?.trim();
        if (left && right) {
          addAliasPair(left, right, 'alias_apposition', passage.passageId);
        }
      }

      for (const match of passage.text.matchAll(parentheticalPattern)) {
        const left = match[1]?.trim();
        const right = match[2]?.trim();
        if (left && right) {
          addAliasPair(left, right, 'alias_parenthetical', passage.passageId);
        }
      }

      for (const match of passage.text.matchAll(hypernymPattern)) {
        const left = match[1]?.trim();
        const right = match[2]?.trim();
        if (left && right) {
          addHypernymEvidence(left, right, passage.passageId);
        }
      }
    }

    const cooccurrence = new Map<
      string,
      { left: string; right: string; passages: Set<string> }
    >();

    for (const passage of passages) {
      const uniqueMentions = [...new Set(
        passage.entityMentions
          .map((mention) => mention.trim())
          .filter((mention) => mention.length > 0),
      )];

      for (let index = 0; index < uniqueMentions.length; index += 1) {
        const left = uniqueMentions[index];
        if (!left) {
          continue;
        }
        for (let rightIndex = index + 1; rightIndex < uniqueMentions.length; rightIndex += 1) {
          const right = uniqueMentions[rightIndex];
          if (!right) {
            continue;
          }

          const leftEntity = resolveEntity(left);
          const rightEntity = resolveEntity(right);
          if (!leftEntity || !rightEntity || leftEntity === rightEntity) {
            continue;
          }

          const leftTypes = entityStats.get(leftEntity)?.types ?? new Set<string>();
          const rightTypes = entityStats.get(rightEntity)?.types ?? new Set<string>();
          const sharedType = [...leftTypes].some((value) => rightTypes.has(value));
          if (!sharedType || jaccardSimilarity(left, right) < 0.8) {
            continue;
          }

          const key = canonicalPairKey(leftEntity, rightEntity);
          const current = cooccurrence.get(key) ?? {
            left,
            right,
            passages: new Set<string>(),
          };
          current.passages.add(passage.passageId);
          cooccurrence.set(key, current);
        }
      }
    }

    for (const pair of cooccurrence.values()) {
      if (pair.passages.size < 2) {
        continue;
      }
      addAliasPair(pair.left, pair.right, 'alias_cooccurrence', [...pair.passages][0] ?? '');
    }

    return {
      stopwordExcluded: this.getStopwordEntities().size,
    };
  }

  private recomputeThesaurusRelations(): number {
    this.db.prepare(
      'DELETE FROM thesaurus_relations WHERE corpus_id = ?',
    ).run(this.corpusId);

    const stopwords = this.getStopwordEntities();
    const ambiguous = this.getAmbiguousSurfaces();
    const now = nowIsoString();
    const dictionaryRows = this.db.prepare(
      `SELECT term, canonical_form, aliases_json
       FROM term_dictionary
       WHERE corpus_id = ?`,
    ).all(this.corpusId) as DictionaryRow[];

    const dictionaryByTerm = new Map<string, DictionaryRow>();
    for (const row of dictionaryRows) {
      dictionaryByTerm.set(normalizeText(row.term), row);
    }

    const upsertRelation = this.db.prepare(
      `INSERT OR REPLACE INTO thesaurus_relations (
         relation_id, corpus_id, source_term, target_term, relation_type, language,
         weight, bidirectional, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const insertRelation = (
      sourceTerm: string,
      targetTerm: string,
      relationType: 'synonym' | 'hypernym',
      weight: number,
      bidirectional: boolean,
    ): void => {
      const sourceNormalized = normalizeText(sourceTerm);
      const targetNormalized = normalizeText(targetTerm);
      if (!sourceNormalized || !targetNormalized || sourceNormalized === targetNormalized) {
        return;
      }

      if (stopwords.has(sourceNormalized) || stopwords.has(targetNormalized)) {
        return;
      }

      if (
        relationType === 'synonym'
        && (ambiguous.has(sourceNormalized) || ambiguous.has(targetNormalized))
      ) {
        return;
      }

      upsertRelation.run(
        `rel:${this.corpusId}:${sourceNormalized}:${targetNormalized}:${relationType}`,
        this.corpusId,
        sourceTerm,
        targetTerm,
        relationType,
        'unknown',
        weight,
        bidirectional ? 1 : 0,
        now,
        now,
      );
    };

    for (const row of dictionaryRows) {
      const termNormalized = normalizeText(row.term);
      if (stopwords.has(termNormalized)) {
        continue;
      }

      for (const alias of parseJsonArray<string>(row.aliases_json)) {
        insertRelation(row.canonical_form, alias, 'synonym', 1, true);
      }
    }

    const relationRows = this.db.prepare(
      `SELECT entity_normalized, related_entity, MAX(confidence) AS confidence
       FROM lexicon_evidence
       WHERE corpus_id = ?
         AND evidence_type IN ('alias_apposition', 'alias_parenthetical', 'alias_cooccurrence')
         AND related_entity <> ''
       GROUP BY entity_normalized, related_entity`,
    ).all(this.corpusId) as RelatedEvidenceRow[];

    for (const row of relationRows) {
      const source = dictionaryByTerm.get(normalizeText(row.entity_normalized))?.canonical_form
        ?? row.entity_normalized;
      const target = dictionaryByTerm.get(normalizeText(row.related_entity))?.canonical_form
        ?? this.resolveAliasSurface(row.entity_normalized, row.related_entity, source)
        ?? row.related_entity;
      insertRelation(source, target, 'synonym', row.confidence, true);
    }

    const hypernymRows = this.db.prepare(
      `SELECT entity_normalized, related_entity, MAX(confidence) AS confidence
       FROM lexicon_evidence
       WHERE corpus_id = ?
         AND evidence_type = 'hypernym'
         AND related_entity <> ''
       GROUP BY entity_normalized, related_entity`,
    ).all(this.corpusId) as RelatedEvidenceRow[];

    for (const row of hypernymRows) {
      const source = dictionaryByTerm.get(normalizeText(row.entity_normalized))?.canonical_form
        ?? row.entity_normalized;
      insertRelation(source, row.related_entity, 'hypernym', row.confidence, false);
    }

    const countRow = this.db.prepare(
      'SELECT COUNT(*) AS count FROM thesaurus_relations WHERE corpus_id = ?',
    ).get(this.corpusId) as { count: number } | undefined;

    return countRow?.count ?? 0;
  }

  private resolveAliasSurface(
    entityNormalized: string,
    relatedEntity: string,
    sourceCanonicalForm: string,
  ): string | undefined {
    const row = this.db.prepare(
      `SELECT surface_form, SUM(occurrence_count) AS frequency
       FROM lexicon_evidence
       WHERE corpus_id = ?
         AND entity_normalized = ?
         AND related_entity = ?
         AND evidence_type IN ('alias_apposition', 'alias_parenthetical', 'alias_cooccurrence')
         AND LOWER(surface_form) <> LOWER(?)
       GROUP BY surface_form
       ORDER BY frequency DESC, surface_form
       LIMIT 1`,
    ).get(
      this.corpusId,
      entityNormalized,
      relatedEntity,
      sourceCanonicalForm,
    ) as EvidenceSurfaceRow | undefined;

    return row?.surface_form;
  }

  private recomputeAmbiguity(): number {
    const ambiguous = this.getAmbiguousSurfaces();
    if (ambiguous.size === 0) {
      return 0;
    }

    const rows = this.db.prepare(
      `SELECT term_id, aliases_json
       FROM term_dictionary
       WHERE corpus_id = ?`,
    ).all(this.corpusId) as { term_id: string; aliases_json: string }[];

    const updateAliases = this.db.prepare(
      'UPDATE term_dictionary SET aliases_json = ?, updated_at = ? WHERE term_id = ?',
    );

    const now = nowIsoString();
    let excluded = 0;
    for (const row of rows) {
      const aliases = parseJsonArray<string>(row.aliases_json);
      const filteredAliases = aliases.filter((alias) => !ambiguous.has(normalizeText(alias)));
      excluded += aliases.length - filteredAliases.length;
      if (filteredAliases.length === aliases.length) {
        continue;
      }

      updateAliases.run(JSON.stringify(filteredAliases), now, row.term_id);
    }

    return excluded;
  }

  private getStopwordEntities(): Set<string> {
    const rows = this.db.prepare(
      `SELECT entity_normalized, SUM(occurrence_count) AS frequency
       FROM lexicon_evidence
       WHERE corpus_id = ? AND evidence_type = 'frequency'
       GROUP BY entity_normalized
       ORDER BY frequency DESC, entity_normalized`,
    ).all(this.corpusId) as EntityAggregate[];

    const stopwordCount = Math.floor(rows.length * 0.01);
    return new Set(rows.slice(0, stopwordCount).map((row) => row.entity_normalized));
  }

  private getAmbiguousSurfaces(): Set<string> {
    const rows = this.db.prepare(
      `SELECT LOWER(surface_form) AS surface_form
       FROM lexicon_evidence
       WHERE corpus_id = ?
         AND evidence_type IN (
           'frequency',
           'alias_apposition',
           'alias_parenthetical',
           'alias_cooccurrence'
         )
       GROUP BY LOWER(surface_form)
       HAVING COUNT(DISTINCT entity_normalized) > 1`,
    ).all(this.corpusId) as { surface_form: string }[];

    return new Set(rows.map((row) => row.surface_form));
  }

  private loadFactsForBackfill(): Map<string, Fact[]> {
    const factRows = this.db.prepare(
      `SELECT f.fact_id, f.schema_id, f.head_entity, f.head_type, f.relation, f.tail_entity,
              f.tail_type, f.state, f.confidence, f.temporal_scope,
              f.granularity_parent_fact_id, f.created_at, f.updated_at, fd.document_id
       FROM facts f
       JOIN fact_documents fd ON fd.fact_id = f.fact_id
       WHERE f.corpus_id = ?
       ORDER BY fd.document_id, f.fact_id`,
    ).all(this.corpusId) as FactBackfillRow[];

    const passageRows = this.db.prepare(
      `SELECT fact_id, passage_id
       FROM fact_passages
       WHERE fact_id IN (SELECT fact_id FROM facts WHERE corpus_id = ?)
       ORDER BY fact_id, passage_id`,
    ).all(this.corpusId) as FactPassageRow[];

    const passageIdsByFact = new Map<string, string[]>();
    for (const row of passageRows) {
      const ids = passageIdsByFact.get(row.fact_id) ?? [];
      ids.push(row.passage_id);
      passageIdsByFact.set(row.fact_id, ids);
    }

    const factsByDocument = new Map<string, Fact[]>();
    for (const row of factRows) {
      const facts = factsByDocument.get(row.document_id) ?? [];
      facts.push({
        factId: row.fact_id,
        corpusId: this.corpusId,
        schemaId: row.schema_id,
        headEntity: row.head_entity,
        headType: row.head_type,
        relation: row.relation,
        tailEntity: row.tail_entity,
        tailType: row.tail_type,
        state: row.state,
        passageIds: passageIdsByFact.get(row.fact_id) ?? [],
        sourceDocumentIds: [row.document_id],
        confidence: row.confidence,
        temporalScope: row.temporal_scope ?? undefined,
        granularityParentFactId: row.granularity_parent_fact_id ?? undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
      factsByDocument.set(row.document_id, facts);
    }

    return factsByDocument;
  }

  private loadPassagesForBackfill(): Map<string, Passage[]> {
    const rows = this.db.prepare(
      `SELECT p.passage_id, p.corpus_id, p.document_id, p.text, p.normalized_text,
              d.title, d.source_url, d.doi, d.source_db, d.source_type, d.language,
              d.converted_at, p.section_path, p.chunk_id, p.chunk_index, p.offset_start,
              p.offset_end, p.entity_mentions, p.quality_flags, p.quality_score,
              p.created_at, p.updated_at
       FROM passages p
       JOIN documents d ON d.document_id = p.document_id
       WHERE p.corpus_id = ?
       ORDER BY p.document_id, p.passage_id`,
    ).all(this.corpusId) as PassageBackfillRow[];

    const factPassageRows = this.db.prepare(
      `SELECT fp.fact_id, fp.passage_id
       FROM fact_passages fp
       JOIN passages p ON p.passage_id = fp.passage_id
       WHERE p.corpus_id = ?
       ORDER BY fp.passage_id, fp.fact_id`,
    ).all(this.corpusId) as FactPassageRow[];

    const factIdsByPassage = new Map<string, string[]>();
    for (const row of factPassageRows) {
      const factIds = factIdsByPassage.get(row.passage_id) ?? [];
      factIds.push(row.fact_id);
      factIdsByPassage.set(row.passage_id, factIds);
    }

    const passagesByDocument = new Map<string, Passage[]>();
    for (const row of rows) {
      const passages = passagesByDocument.get(row.document_id) ?? [];
      passages.push({
        passageId: row.passage_id,
        corpusId: row.corpus_id,
        text: row.text,
        normalizedText: row.normalized_text,
        metadata: {
          documentId: row.document_id,
          title: row.title,
          sourceUrl: row.source_url,
          doi: row.doi ?? undefined,
          sourceDb: row.source_db ?? undefined,
          sourceType: row.source_type ?? undefined,
          language: row.language,
          convertedAt: row.converted_at ?? undefined,
          sectionPath: parseJsonArray<string>(row.section_path),
          chunkId: row.chunk_id,
          chunkIndex: row.chunk_index,
          offsetStart: row.offset_start,
          offsetEnd: row.offset_end,
        },
        factIds: factIdsByPassage.get(row.passage_id) ?? [],
        entityMentions: parseJsonArray<string>(row.entity_mentions),
        qualityFlags: parseJsonArray<string>(row.quality_flags),
        qualityScore: row.quality_score ?? undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
      passagesByDocument.set(row.document_id, passages);
    }

    return passagesByDocument;
  }
}
