-- Migration 0003: Add 'entity' layer support to graph_nodes
-- SQLite does not support ALTER TABLE to modify CHECK constraints,
-- so we recreate the table with the updated constraint.

CREATE TABLE IF NOT EXISTS graph_nodes_new (
  node_id   TEXT NOT NULL,
  corpus_id TEXT NOT NULL REFERENCES corpora(corpus_id) ON DELETE CASCADE,
  layer     TEXT NOT NULL CHECK (layer IN ('ontology', 'fact', 'passage', 'entity')),
  ref_id    TEXT NOT NULL,
  label     TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (corpus_id, node_id)
);

INSERT OR IGNORE INTO graph_nodes_new SELECT * FROM graph_nodes;
DROP TABLE graph_nodes;
ALTER TABLE graph_nodes_new RENAME TO graph_nodes;

CREATE INDEX IF NOT EXISTS idx_graph_nodes_layer ON graph_nodes(corpus_id, layer);
