-- MemGraphRAG Initial Schema Migration
-- Version: 0001
-- DES-MG-030, DES-MG-032

-- Corpora
CREATE TABLE IF NOT EXISTS corpora (
  corpus_id   TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Schemas (Ontology layer M_ont)
CREATE TABLE IF NOT EXISTS schemas (
  schema_id               TEXT PRIMARY KEY,
  corpus_id               TEXT NOT NULL REFERENCES corpora(corpus_id) ON DELETE CASCADE,
  head_type               TEXT NOT NULL,
  relation                TEXT NOT NULL,
  tail_type               TEXT NOT NULL,
  canonical_key           TEXT NOT NULL,
  frequency               INTEGER NOT NULL DEFAULT 0,
  state                   TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'stable')),
  stabilization_threshold INTEGER NOT NULL DEFAULT 2,
  version                 INTEGER NOT NULL DEFAULT 1,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_schemas_corpus ON schemas(corpus_id);
CREATE INDEX IF NOT EXISTS idx_schemas_canonical ON schemas(corpus_id, canonical_key);

-- Schema aliases
CREATE TABLE IF NOT EXISTS schema_aliases (
  alias_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  schema_id    TEXT NOT NULL REFERENCES schemas(schema_id) ON DELETE CASCADE,
  label        TEXT NOT NULL,
  language     TEXT NOT NULL DEFAULT 'en',
  source       TEXT NOT NULL DEFAULT 'llm',
  confidence   REAL NOT NULL DEFAULT 1.0,
  is_canonical INTEGER NOT NULL DEFAULT 0,
  UNIQUE(schema_id, label)
);
CREATE INDEX IF NOT EXISTS idx_aliases_schema ON schema_aliases(schema_id);

-- Facts (Fact layer M_fac)
CREATE TABLE IF NOT EXISTS facts (
  fact_id                    TEXT PRIMARY KEY,
  corpus_id                  TEXT NOT NULL REFERENCES corpora(corpus_id) ON DELETE CASCADE,
  schema_id                  TEXT NOT NULL REFERENCES schemas(schema_id) ON DELETE CASCADE,
  head_entity                TEXT NOT NULL,
  head_type                  TEXT NOT NULL,
  relation                   TEXT NOT NULL,
  tail_entity                TEXT NOT NULL,
  tail_type                  TEXT NOT NULL,
  state                      TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'inactive')),
  confidence                 REAL NOT NULL DEFAULT 1.0,
  temporal_scope             TEXT,
  granularity_parent_fact_id TEXT,
  created_at                 TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                 TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_facts_corpus ON facts(corpus_id);
CREATE INDEX IF NOT EXISTS idx_facts_schema ON facts(schema_id);
CREATE INDEX IF NOT EXISTS idx_facts_state ON facts(corpus_id, state);

-- Documents
CREATE TABLE IF NOT EXISTS documents (
  document_id TEXT PRIMARY KEY,
  corpus_id   TEXT NOT NULL REFERENCES corpora(corpus_id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  source_url  TEXT NOT NULL DEFAULT '',
  doi         TEXT,
  source_db   TEXT,
  source_type TEXT,
  language    TEXT NOT NULL DEFAULT 'en',
  converted_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_documents_corpus ON documents(corpus_id);

-- Passages (Passage layer M_pas)
CREATE TABLE IF NOT EXISTS passages (
  passage_id      TEXT PRIMARY KEY,
  corpus_id       TEXT NOT NULL REFERENCES corpora(corpus_id) ON DELETE CASCADE,
  document_id     TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
  text            TEXT NOT NULL,
  normalized_text TEXT NOT NULL DEFAULT '',
  section_path    TEXT NOT NULL DEFAULT '[]',
  chunk_id        TEXT NOT NULL,
  chunk_index     INTEGER NOT NULL DEFAULT 0,
  offset_start    INTEGER NOT NULL DEFAULT 0,
  offset_end      INTEGER NOT NULL DEFAULT 0,
  entity_mentions TEXT NOT NULL DEFAULT '[]',
  quality_flags   TEXT NOT NULL DEFAULT '[]',
  quality_score   REAL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_passages_corpus ON passages(corpus_id);
CREATE INDEX IF NOT EXISTS idx_passages_document ON passages(document_id);

-- Fact-Passage links (Ψ mapping)
CREATE TABLE IF NOT EXISTS fact_passages (
  fact_id    TEXT NOT NULL REFERENCES facts(fact_id) ON DELETE CASCADE,
  passage_id TEXT NOT NULL REFERENCES passages(passage_id) ON DELETE CASCADE,
  PRIMARY KEY (fact_id, passage_id)
);

-- Schema-Document links
CREATE TABLE IF NOT EXISTS schema_documents (
  schema_id   TEXT NOT NULL REFERENCES schemas(schema_id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
  PRIMARY KEY (schema_id, document_id)
);

-- Fact-Document links
CREATE TABLE IF NOT EXISTS fact_documents (
  fact_id     TEXT NOT NULL REFERENCES facts(fact_id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
  PRIMARY KEY (fact_id, document_id)
);

-- Graph nodes
CREATE TABLE IF NOT EXISTS graph_nodes (
  node_id   TEXT NOT NULL,
  corpus_id TEXT NOT NULL REFERENCES corpora(corpus_id) ON DELETE CASCADE,
  layer     TEXT NOT NULL CHECK (layer IN ('ontology', 'fact', 'passage')),
  ref_id    TEXT NOT NULL,
  label     TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (corpus_id, node_id)
);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_layer ON graph_nodes(corpus_id, layer);

-- Graph edges
CREATE TABLE IF NOT EXISTS graph_edges (
  edge_id        TEXT NOT NULL,
  corpus_id      TEXT NOT NULL REFERENCES corpora(corpus_id) ON DELETE CASCADE,
  source_node_id TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  relation       TEXT NOT NULL,
  weight         REAL NOT NULL DEFAULT 1.0,
  bridge_kind    TEXT,
  PRIMARY KEY (corpus_id, edge_id)
);
CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON graph_edges(corpus_id, source_node_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON graph_edges(corpus_id, target_node_id);

-- Term dictionary (lexicon)
CREATE TABLE IF NOT EXISTS term_dictionary (
  term_id         TEXT PRIMARY KEY,
  corpus_id       TEXT NOT NULL REFERENCES corpora(corpus_id) ON DELETE CASCADE,
  term            TEXT NOT NULL,
  canonical_form  TEXT NOT NULL,
  domain_category TEXT NOT NULL DEFAULT '',
  aliases_json    TEXT NOT NULL DEFAULT '[]',
  frequency       INTEGER NOT NULL DEFAULT 0,
  confidence      REAL NOT NULL DEFAULT 1.0,
  source          TEXT NOT NULL DEFAULT 'manual',
  version         TEXT NOT NULL DEFAULT '1',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_term_dict_corpus ON term_dictionary(corpus_id);
CREATE INDEX IF NOT EXISTS idx_term_dict_term ON term_dictionary(corpus_id, term);

-- Thesaurus relations
CREATE TABLE IF NOT EXISTS thesaurus_relations (
  relation_id   TEXT PRIMARY KEY,
  corpus_id     TEXT NOT NULL REFERENCES corpora(corpus_id) ON DELETE CASCADE,
  source_term   TEXT NOT NULL,
  target_term   TEXT NOT NULL,
  relation_type TEXT NOT NULL CHECK (relation_type IN ('synonym', 'hypernym', 'hyponym', 'related')),
  language      TEXT NOT NULL DEFAULT 'en',
  weight        REAL NOT NULL DEFAULT 1.0,
  bidirectional INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_thesaurus_corpus ON thesaurus_relations(corpus_id);
CREATE INDEX IF NOT EXISTS idx_thesaurus_source ON thesaurus_relations(corpus_id, source_term);

-- Dictionary candidates (auto-discovered)
CREATE TABLE IF NOT EXISTS dictionary_candidates (
  candidate_id TEXT PRIMARY KEY,
  corpus_id    TEXT NOT NULL REFERENCES corpora(corpus_id) ON DELETE CASCADE,
  term         TEXT NOT NULL,
  frequency    INTEGER NOT NULL DEFAULT 1,
  confidence   REAL NOT NULL DEFAULT 0.0,
  source       TEXT NOT NULL DEFAULT 'extracted',
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_dict_candidates_corpus ON dictionary_candidates(corpus_id);

-- Jobs (async indexing)
CREATE TABLE IF NOT EXISTS jobs (
  job_id     TEXT PRIMARY KEY,
  corpus_id  TEXT NOT NULL REFERENCES corpora(corpus_id) ON DELETE CASCADE,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  total      INTEGER NOT NULL DEFAULT 0,
  processed  INTEGER NOT NULL DEFAULT 0,
  errors_json TEXT NOT NULL DEFAULT '[]',
  summary    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_jobs_corpus ON jobs(corpus_id);

-- Job checkpoints
CREATE TABLE IF NOT EXISTS checkpoints (
  job_id                 TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
  processed_document_ids TEXT NOT NULL DEFAULT '[]',
  updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (job_id)
);

-- Audit log
CREATE TABLE IF NOT EXISTS audit_logs (
  log_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  corpus_id  TEXT NOT NULL,
  action     TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id  TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_corpus ON audit_logs(corpus_id);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs(created_at);

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_versions (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now')),
  filename   TEXT NOT NULL
);
