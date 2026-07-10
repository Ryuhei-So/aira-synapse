# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Security
- **Path traversal via `corpus_id` (high)**: MCP `corpus_id` / `job_id` / `document_id`
  were used as filesystem path segments without validation, allowing `..` / absolute
  paths to escape the vector-index storage root
  - Added `requiredIdentifier` (`[A-Za-z0-9_-]{1,128}`) validation at the MCP boundary
  - Added `resolveWithin()` path-confinement guard in `FileVectorIndex` /
    `CachedFileVectorIndex` as defense-in-depth (also covers CLI / direct API use)
- **Secret redaction (`SecretMasker`)**: broadened patterns to catch modern
  `sk-proj-` / `sk-svcacct-` / `sk-ant-` keys plus GitHub / Slack / AWS tokens;
  `maskObject` now masks per-value instead of round-tripping through JSON
  (removes a JSON-corruption crash path)
- **Prototype pollution**: config loader `transformKeys` now uses a null-prototype
  object and skips `__proto__` / `constructor` / `prototype` keys
- **`export_graph` DoS**: `limit` / `offset` clamped to sane bounds (negative
  `limit` previously disabled SQLite's row cap)
- **Dependencies**: `npm audit fix` — hono 4.12.24 → 4.12.28 (path traversal,
  CORS, body-limit advisories resolved)
- **Ops hardening**: docker-compose Neo4j ports bound to `127.0.0.1`, password
  overridable via `NEO4J_PASSWORD`; on-disk API key files restricted to `600`

## [0.6.0] - 2026-06-24

### Added
- **Federated Query**: Query across multiple .agdb databases with RRF-based result merging
  - `FederatedQueryService` — parallel retrieval, shared embedding, soft timeout
  - `DefaultRRFMerger` — Reciprocal Rank Fusion with deduplication and contribution cap
  - Citation namespacing for multi-DB traceability
  - Graceful partial failure handling (returns results even if some DBs fail)
- `DefaultQueryService` refactored: `prepare()` / `retrievePrepared()` / `answer()` split
  - Enables federation to call prepare once, retrieve per-DB, answer once
- `IMemoryFilter.filter()` accepts optional `precomputedVector` parameter
- `FilteredMemoryCandidates` returns `queryVector` for reuse
- `textHash` utility for passage deduplication (SHA-256)
- `softTimeout` utility for per-DB timeout with deferred cleanup
- `dbValidation` utility for CLI --db spec parsing
- E2E test: Federated query across EN + JP corpora (Neo4j backend)

### Changed
- Architecture diagram updated (FederatedQueryService + RRF Merger)
- README.md / README-ja.md updated with Federated Query documentation

### Fixed
- `namespacePassage()` / `namespaceFact()` — guard against undefined arrays
- Layer boundary violation: removed infrastructure import from application layer

## [0.5.0] - 2026-06-22

### Added
- README.md / README-ja.md
- MIT License
- Japanese benchmark experiments (GPT-5.5: 78.3% JA accuracy)
- GINZA sentence chunking for Japanese corpora

## [0.4.0] - 2026-06-20

### Added
- HotpotQA EN benchmark: 91.2% LLM-Acc (456/500)
- Neo4j backend support
- Hybrid retrieval (Vector + BM25 RRF)
- MCP server integration
- Domain dictionary and thesaurus
