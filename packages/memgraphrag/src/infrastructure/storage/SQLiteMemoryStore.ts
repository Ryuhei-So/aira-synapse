/**
 * Infrastructure Layer — SQLite-backed memory snapshot adapter.
 * DES-MG-032: Authoritative SQLite persistence for MemorySnapshot and checkpoints.
 */

import type Database from 'better-sqlite3';
import type { Fact } from '../../domain/memory/fact.js';
import type { MemorySnapshot } from '../../domain/memory/globalMemory.js';
import type { Passage } from '../../domain/memory/passage.js';
import type { Schema, SchemaAlias } from '../../domain/memory/schema.js';
import type { JobCheckpoint, IMemoryStore } from '../../domain/storage/graphStore.js';

interface SchemaRow {
  readonly schema_id: string;
  readonly corpus_id: string;
  readonly head_type: string;
  readonly relation: string;
  readonly tail_type: string;
  readonly canonical_key: string;
  readonly frequency: number;
  readonly state: Schema['state'];
  readonly stabilization_threshold: number;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
}

interface SchemaAliasRow {
  readonly schema_id: string;
  readonly label: string;
  readonly language: SchemaAlias['language'];
  readonly source: SchemaAlias['source'];
  readonly confidence: number;
  readonly is_canonical: number;
}

interface SchemaDocumentRow {
  readonly schema_id: string;
  readonly document_id: string;
}

interface FactRow {
  readonly fact_id: string;
  readonly corpus_id: string;
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
}

interface FactDocumentRow {
  readonly fact_id: string;
  readonly document_id: string;
}

interface FactPassageRow {
  readonly fact_id: string;
  readonly passage_id: string;
}

interface PassageRow {
  readonly passage_id: string;
  readonly corpus_id: string;
  readonly text: string;
  readonly normalized_text: string;
  readonly document_id: string;
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

function parseJsonArray<T>(value: string): readonly T[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? (parsed as readonly T[]) : [];
}

function nowIsoString(): string {
  return new Date().toISOString();
}

export class SQLiteMemoryStore implements IMemoryStore {
  public constructor(private readonly db: Database.Database) {}

  public async load(corpusId: string): Promise<MemorySnapshot> {
    const schemaRows = this.db.prepare(
      `SELECT schema_id, corpus_id, head_type, relation, tail_type, canonical_key,
              frequency, state, stabilization_threshold, version, created_at, updated_at
       FROM schemas
       WHERE corpus_id = ?
       ORDER BY schema_id`,
    ).all(corpusId) as SchemaRow[];

    const schemaAliases = this.db.prepare(
      `SELECT schema_id, label, language, source, confidence, is_canonical
       FROM schema_aliases
       WHERE schema_id IN (
         SELECT schema_id FROM schemas WHERE corpus_id = ?
       )
       ORDER BY schema_id, is_canonical DESC, label`,
    ).all(corpusId) as SchemaAliasRow[];

    const schemaDocuments = this.db.prepare(
      `SELECT sd.schema_id, sd.document_id
       FROM schema_documents sd
       JOIN schemas s ON s.schema_id = sd.schema_id
       WHERE s.corpus_id = ?
       ORDER BY sd.schema_id, sd.document_id`,
    ).all(corpusId) as SchemaDocumentRow[];

    const factRows = this.db.prepare(
      `SELECT fact_id, corpus_id, schema_id, head_entity, head_type, relation, tail_entity,
              tail_type, state, confidence, temporal_scope, granularity_parent_fact_id,
              created_at, updated_at
       FROM facts
       WHERE corpus_id = ?
       ORDER BY fact_id`,
    ).all(corpusId) as FactRow[];

    const factDocuments = this.db.prepare(
      `SELECT fd.fact_id, fd.document_id
       FROM fact_documents fd
       JOIN facts f ON f.fact_id = fd.fact_id
       WHERE f.corpus_id = ?
       ORDER BY fd.fact_id, fd.document_id`,
    ).all(corpusId) as FactDocumentRow[];

    const factPassages = this.db.prepare(
      `SELECT fp.fact_id, fp.passage_id
       FROM fact_passages fp
       JOIN facts f ON f.fact_id = fp.fact_id
       WHERE f.corpus_id = ?
       ORDER BY fp.fact_id, fp.passage_id`,
    ).all(corpusId) as FactPassageRow[];

    const passageRows = this.db.prepare(
      `SELECT p.passage_id, p.corpus_id, p.text, p.normalized_text, p.document_id,
              d.title, d.source_url, d.doi, d.source_db, d.source_type, d.language,
              d.converted_at, p.section_path, p.chunk_id, p.chunk_index, p.offset_start,
              p.offset_end, p.entity_mentions, p.quality_flags, p.quality_score,
              p.created_at, p.updated_at
       FROM passages p
       JOIN documents d ON d.document_id = p.document_id
       WHERE p.corpus_id = ?
       ORDER BY p.passage_id`,
    ).all(corpusId) as PassageRow[];

    const aliasesBySchema = new Map<string, SchemaAlias[]>();
    for (const alias of schemaAliases) {
      const aliases = aliasesBySchema.get(alias.schema_id) ?? [];
      aliases.push({
        label: alias.label,
        language: alias.language,
        source: alias.source,
        confidence: alias.confidence,
        isCanonical: alias.is_canonical === 1,
      });
      aliasesBySchema.set(alias.schema_id, aliases);
    }

    const schemaDocumentsById = new Map<string, string[]>();
    for (const row of schemaDocuments) {
      const documentIds = schemaDocumentsById.get(row.schema_id) ?? [];
      documentIds.push(row.document_id);
      schemaDocumentsById.set(row.schema_id, documentIds);
    }

    const factsBySchema = new Map<string, string[]>();
    for (const row of factRows) {
      const factIds = factsBySchema.get(row.schema_id) ?? [];
      factIds.push(row.fact_id);
      factsBySchema.set(row.schema_id, factIds);
    }

    const factDocumentsById = new Map<string, string[]>();
    for (const row of factDocuments) {
      const documentIds = factDocumentsById.get(row.fact_id) ?? [];
      documentIds.push(row.document_id);
      factDocumentsById.set(row.fact_id, documentIds);
    }

    const passageIdsByFact = new Map<string, string[]>();
    const factIdsByPassage = new Map<string, string[]>();
    for (const row of factPassages) {
      const passageIds = passageIdsByFact.get(row.fact_id) ?? [];
      passageIds.push(row.passage_id);
      passageIdsByFact.set(row.fact_id, passageIds);

      const factIds = factIdsByPassage.get(row.passage_id) ?? [];
      factIds.push(row.fact_id);
      factIdsByPassage.set(row.passage_id, factIds);
    }

    const schemas: Schema[] = schemaRows.map((row) => ({
      schemaId: row.schema_id,
      corpusId: row.corpus_id,
      headType: row.head_type,
      relation: row.relation,
      tailType: row.tail_type,
      canonicalKey: row.canonical_key,
      aliases: aliasesBySchema.get(row.schema_id) ?? [],
      frequency: row.frequency,
      state: row.state,
      stabilizationThreshold: row.stabilization_threshold,
      factIds: factsBySchema.get(row.schema_id) ?? [],
      sourceDocumentIds: schemaDocumentsById.get(row.schema_id) ?? [],
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    const facts: Fact[] = factRows.map((row) => ({
      factId: row.fact_id,
      corpusId: row.corpus_id,
      schemaId: row.schema_id,
      headEntity: row.head_entity,
      headType: row.head_type,
      relation: row.relation,
      tailEntity: row.tail_entity,
      tailType: row.tail_type,
      state: row.state,
      passageIds: passageIdsByFact.get(row.fact_id) ?? [],
      sourceDocumentIds: factDocumentsById.get(row.fact_id) ?? [],
      confidence: row.confidence,
      temporalScope: row.temporal_scope ?? undefined,
      granularityParentFactId: row.granularity_parent_fact_id ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    const passages: Passage[] = passageRows.map((row) => ({
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
    }));

    const versionRow = this.db.prepare(
      'SELECT COALESCE(MAX(version), 0) AS version FROM schema_versions',
    ).get() as { version: number };

    return {
      corpusId,
      exportedAt: nowIsoString(),
      schemas,
      facts,
      passages,
      schemaVersion: versionRow.version,
    };
  }

  public async save(snapshot: MemorySnapshot): Promise<void> {
    const corpus = this.db.prepare(
      'SELECT corpus_id FROM corpora WHERE corpus_id = ?',
    ).get(snapshot.corpusId) as { corpus_id: string } | undefined;

    if (!corpus) {
      throw new Error(`Corpus ${snapshot.corpusId} does not exist`);
    }

    const upsertSchema = this.db.prepare(
      `INSERT INTO schemas (
         schema_id, corpus_id, head_type, relation, tail_type, canonical_key,
         frequency, state, stabilization_threshold, version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(schema_id) DO UPDATE SET
         corpus_id = excluded.corpus_id,
         head_type = excluded.head_type,
         relation = excluded.relation,
         tail_type = excluded.tail_type,
         canonical_key = excluded.canonical_key,
         frequency = excluded.frequency,
         state = excluded.state,
         stabilization_threshold = excluded.stabilization_threshold,
         version = excluded.version,
         updated_at = excluded.updated_at`,
    );
    const deleteSchemaAliases = this.db.prepare(
      'DELETE FROM schema_aliases WHERE schema_id = ?',
    );
    const insertSchemaAlias = this.db.prepare(
      `INSERT INTO schema_aliases (
         schema_id, label, language, source, confidence, is_canonical
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const deleteSchemaDocuments = this.db.prepare(
      'DELETE FROM schema_documents WHERE schema_id = ?',
    );
    const insertSchemaDocument = this.db.prepare(
      'INSERT OR IGNORE INTO schema_documents (schema_id, document_id) VALUES (?, ?)',
    );

    const upsertDocument = this.db.prepare(
      `INSERT INTO documents (
         document_id, corpus_id, title, source_url, doi, source_db, source_type,
         language, converted_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(document_id) DO UPDATE SET
         corpus_id = excluded.corpus_id,
         title = excluded.title,
         source_url = excluded.source_url,
         doi = excluded.doi,
         source_db = excluded.source_db,
         source_type = excluded.source_type,
         language = excluded.language,
         converted_at = excluded.converted_at,
         updated_at = excluded.updated_at`,
    );
    const upsertPassage = this.db.prepare(
      `INSERT INTO passages (
         passage_id, corpus_id, document_id, text, normalized_text, section_path,
         chunk_id, chunk_index, offset_start, offset_end, entity_mentions,
         quality_flags, quality_score, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(passage_id) DO UPDATE SET
         corpus_id = excluded.corpus_id,
         document_id = excluded.document_id,
         text = excluded.text,
         normalized_text = excluded.normalized_text,
         section_path = excluded.section_path,
         chunk_id = excluded.chunk_id,
         chunk_index = excluded.chunk_index,
         offset_start = excluded.offset_start,
         offset_end = excluded.offset_end,
         entity_mentions = excluded.entity_mentions,
         quality_flags = excluded.quality_flags,
         quality_score = excluded.quality_score,
         updated_at = excluded.updated_at`,
    );

    const upsertFact = this.db.prepare(
      `INSERT INTO facts (
         fact_id, corpus_id, schema_id, head_entity, head_type, relation, tail_entity,
         tail_type, state, confidence, temporal_scope, granularity_parent_fact_id,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(fact_id) DO UPDATE SET
         corpus_id = excluded.corpus_id,
         schema_id = excluded.schema_id,
         head_entity = excluded.head_entity,
         head_type = excluded.head_type,
         relation = excluded.relation,
         tail_entity = excluded.tail_entity,
         tail_type = excluded.tail_type,
         state = excluded.state,
         confidence = excluded.confidence,
         temporal_scope = excluded.temporal_scope,
         granularity_parent_fact_id = excluded.granularity_parent_fact_id,
         updated_at = excluded.updated_at`,
    );
    const deleteFactDocuments = this.db.prepare(
      'DELETE FROM fact_documents WHERE fact_id = ?',
    );
    const insertFactDocument = this.db.prepare(
      'INSERT OR IGNORE INTO fact_documents (fact_id, document_id) VALUES (?, ?)',
    );
    const deleteFactPassages = this.db.prepare(
      'DELETE FROM fact_passages WHERE fact_id = ?',
    );
    const insertFactPassage = this.db.prepare(
      'INSERT OR IGNORE INTO fact_passages (fact_id, passage_id) VALUES (?, ?)',
    );

    const transaction = this.db.transaction((nextSnapshot: MemorySnapshot) => {
      const referencedDocumentIds = new Set<string>();
      for (const schema of nextSnapshot.schemas) {
        for (const documentId of schema.sourceDocumentIds) {
          referencedDocumentIds.add(documentId);
        }
      }
      for (const fact of nextSnapshot.facts) {
        for (const documentId of fact.sourceDocumentIds) {
          referencedDocumentIds.add(documentId);
        }
      }
      for (const passage of nextSnapshot.passages) {
        referencedDocumentIds.add(passage.metadata.documentId);
      }

      for (const documentId of referencedDocumentIds) {
        upsertDocument.run(
          documentId,
          nextSnapshot.corpusId,
          documentId,
          '',
          null,
          null,
          null,
          'unknown',
          null,
          nextSnapshot.exportedAt,
        );
      }

      for (const schema of nextSnapshot.schemas) {
        upsertSchema.run(
          schema.schemaId,
          schema.corpusId,
          schema.headType,
          schema.relation,
          schema.tailType,
          schema.canonicalKey,
          schema.frequency,
          schema.state,
          schema.stabilizationThreshold,
          schema.version,
          schema.createdAt,
          schema.updatedAt,
        );

        deleteSchemaAliases.run(schema.schemaId);
        for (const alias of schema.aliases) {
          insertSchemaAlias.run(
            schema.schemaId,
            alias.label,
            alias.language,
            alias.source,
            alias.confidence,
            alias.isCanonical ? 1 : 0,
          );
        }

        deleteSchemaDocuments.run(schema.schemaId);
        for (const documentId of schema.sourceDocumentIds) {
          insertSchemaDocument.run(schema.schemaId, documentId);
        }
      }

      for (const passage of nextSnapshot.passages) {
        upsertDocument.run(
          passage.metadata.documentId,
          passage.corpusId,
          passage.metadata.title,
          passage.metadata.sourceUrl,
          passage.metadata.doi ?? null,
          passage.metadata.sourceDb ?? null,
          passage.metadata.sourceType ?? null,
          passage.metadata.language,
          passage.metadata.convertedAt ?? null,
          passage.updatedAt,
        );

        upsertPassage.run(
          passage.passageId,
          passage.corpusId,
          passage.metadata.documentId,
          passage.text,
          passage.normalizedText,
          JSON.stringify(passage.metadata.sectionPath),
          passage.metadata.chunkId,
          passage.metadata.chunkIndex,
          passage.metadata.offsetStart,
          passage.metadata.offsetEnd,
          JSON.stringify(passage.entityMentions),
          JSON.stringify(passage.qualityFlags),
          passage.qualityScore ?? null,
          passage.createdAt,
          passage.updatedAt,
        );
      }

      for (const fact of nextSnapshot.facts) {
        upsertFact.run(
          fact.factId,
          fact.corpusId,
          fact.schemaId,
          fact.headEntity,
          fact.headType,
          fact.relation,
          fact.tailEntity,
          fact.tailType,
          fact.state,
          fact.confidence,
          fact.temporalScope ?? null,
          fact.granularityParentFactId ?? null,
          fact.createdAt,
          fact.updatedAt,
        );

        deleteFactDocuments.run(fact.factId);
        for (const documentId of fact.sourceDocumentIds) {
          insertFactDocument.run(fact.factId, documentId);
        }

        deleteFactPassages.run(fact.factId);
        for (const passageId of fact.passageIds) {
          insertFactPassage.run(fact.factId, passageId);
        }
      }
    });

    transaction(snapshot);
  }

  public async saveCheckpoint(checkpoint: JobCheckpoint): Promise<void> {
    const transaction = this.db.transaction((nextCheckpoint: JobCheckpoint) => {
      this.db.prepare(
        `INSERT OR REPLACE INTO jobs (
           job_id, corpus_id, status, total, processed, errors_json, updated_at
         ) VALUES (?, ?, 'running', ?, ?, '[]', ?)`,
      ).run(
        nextCheckpoint.jobId,
        nextCheckpoint.corpusId,
        nextCheckpoint.processedDocumentIds.length,
        nextCheckpoint.processedDocumentIds.length,
        nextCheckpoint.updatedAt,
      );

      this.db.prepare(
        `INSERT OR REPLACE INTO checkpoints (
           job_id, processed_document_ids, updated_at
         ) VALUES (?, ?, ?)`,
      ).run(
        nextCheckpoint.jobId,
        JSON.stringify(nextCheckpoint.processedDocumentIds),
        nextCheckpoint.updatedAt,
      );
    });

    transaction(checkpoint);
  }

  public async loadCheckpoint(jobId: string): Promise<JobCheckpoint | null> {
    const row = this.db.prepare(
      `SELECT j.job_id, j.corpus_id, c.processed_document_ids, c.updated_at
       FROM jobs j
       JOIN checkpoints c ON c.job_id = j.job_id
       WHERE j.job_id = ?`,
    ).get(jobId) as
      | {
          job_id: string;
          corpus_id: string;
          processed_document_ids: string;
          updated_at: string;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      jobId: row.job_id,
      corpusId: row.corpus_id,
      processedDocumentIds: parseJsonArray<string>(row.processed_document_ids),
      updatedAt: row.updated_at,
    };
  }

  public async validateIntegrity(corpusId: string): Promise<readonly string[]> {
    const issues: string[] = [];

    const brokenPhi = this.db.prepare(
      `SELECT f.fact_id, f.schema_id
       FROM facts f
       LEFT JOIN schemas s
         ON s.schema_id = f.schema_id AND s.corpus_id = f.corpus_id
       WHERE f.corpus_id = ? AND s.schema_id IS NULL
       ORDER BY f.fact_id`,
    ).all(corpusId) as { fact_id: string; schema_id: string }[];
    for (const row of brokenPhi) {
      issues.push(
        `Broken Φ: fact ${row.fact_id} references missing schema ${row.schema_id}`,
      );
    }

    const brokenPsiPassages = this.db.prepare(
      `SELECT fp.fact_id, fp.passage_id
       FROM fact_passages fp
       JOIN facts f ON f.fact_id = fp.fact_id
       LEFT JOIN passages p ON p.passage_id = fp.passage_id
       WHERE f.corpus_id = ? AND p.passage_id IS NULL
       ORDER BY fp.fact_id, fp.passage_id`,
    ).all(corpusId) as { fact_id: string; passage_id: string }[];
    for (const row of brokenPsiPassages) {
      issues.push(
        `Broken Ψ: fact ${row.fact_id} references missing passage ${row.passage_id}`,
      );
    }

    const brokenPsiFacts = this.db.prepare(
      `SELECT fp.fact_id, fp.passage_id
       FROM fact_passages fp
       JOIN passages p ON p.passage_id = fp.passage_id
       LEFT JOIN facts f ON f.fact_id = fp.fact_id
       WHERE p.corpus_id = ? AND f.fact_id IS NULL
       ORDER BY fp.fact_id, fp.passage_id`,
    ).all(corpusId) as { fact_id: string; passage_id: string }[];
    for (const row of brokenPsiFacts) {
      issues.push(
        `Broken Ψ: passage ${row.passage_id} references missing fact ${row.fact_id}`,
      );
    }

    const orphanEdges = this.db.prepare(
      `SELECT ge.edge_id, ge.source_node_id, ge.target_node_id
       FROM graph_edges ge
       LEFT JOIN graph_nodes src
         ON src.corpus_id = ge.corpus_id AND src.node_id = ge.source_node_id
       LEFT JOIN graph_nodes dst
         ON dst.corpus_id = ge.corpus_id AND dst.node_id = ge.target_node_id
       WHERE ge.corpus_id = ?
         AND (src.node_id IS NULL OR dst.node_id IS NULL)
       ORDER BY ge.edge_id`,
    ).all(corpusId) as {
      edge_id: string;
      source_node_id: string;
      target_node_id: string;
    }[];
    for (const row of orphanEdges) {
      issues.push(
        `Orphan edge: ${row.edge_id} (${row.source_node_id} -> ${row.target_node_id})`,
      );
    }

    return issues;
  }
}
