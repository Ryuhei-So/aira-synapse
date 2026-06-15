-- Migration 0004: Add lexicon_evidence table for dictionary/thesaurus evidence tracking.
-- DES-MG3-001: Supports idempotent incremental lexicon construction.

CREATE TABLE IF NOT EXISTS lexicon_evidence (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  corpus_id     TEXT    NOT NULL REFERENCES corpora(corpus_id) ON DELETE CASCADE,
  document_id   TEXT    NOT NULL,
  entity_normalized TEXT NOT NULL,
  surface_form  TEXT    NOT NULL,
  evidence_type TEXT    NOT NULL CHECK (evidence_type IN (
    'frequency', 'alias_apposition', 'alias_parenthetical',
    'alias_cooccurrence', 'synonym', 'hypernym'
  )),
  related_entity  TEXT    NOT NULL DEFAULT '',
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  confidence      REAL    NOT NULL DEFAULT 0.7,
  source_passage_id TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(corpus_id, document_id, entity_normalized, surface_form, evidence_type, related_entity)
);

CREATE INDEX IF NOT EXISTS idx_lexicon_evidence_doc
  ON lexicon_evidence(corpus_id, document_id);

CREATE INDEX IF NOT EXISTS idx_lexicon_evidence_entity
  ON lexicon_evidence(corpus_id, entity_normalized);
