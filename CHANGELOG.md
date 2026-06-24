# Changelog

All notable changes to this project will be documented in this file.

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
