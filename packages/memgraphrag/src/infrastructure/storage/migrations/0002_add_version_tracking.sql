CREATE TABLE IF NOT EXISTS schema_version_tracking (
  version INTEGER PRIMARY KEY,
  filename TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'applied',
  tracked_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO schema_version_tracking (version, filename, state)
SELECT version, filename, 'applied'
FROM schema_versions;
