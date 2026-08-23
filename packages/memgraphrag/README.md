# MemGraphRAG

**Memory-based Multi-Agent System for Graph Retrieval-Augmented Generation**

[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3%2B-blue)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-527%20passing-brightgreen)]()
[![License](https://img.shields.io/badge/license-MIT-blue)]()

> An implementation of the KDD 2026 paper [*"MemGraphRAG: Memory-based Multi-Agent System for Graph Retrieval-Augmented Generation"*](https://arxiv.org/abs/2606.00610) — enhanced with domain-specific term dictionaries, thesaurus normalization, and Japanese NLP support via GiNZA.

[日本語版 README はこちら](README-ja.md)

---

## ✨ Features

- **Three-Layer Global Memory** — Ontology (M_ont), Facts (M_fac), Passages (M_pas) with bidirectional mappings Φ and Ψ
- **Multi-Agent Indexing** (Algorithm 1 Stage I–IV) — Composite extraction → Schema canonicalization → Conflict detection/resolution → Graph projection + bridging
- **Personalized PageRank (PPR)** — λ=0.5 teleport with hub suppression log(deg+2), convergence detection
- **Domain-Specific Dictionaries** — Term dictionary boost for entity extraction, auto-build from Semantic Scholar
- **Thesaurus Normalization** — Synonym/hypernym/hyponym relations for schema normalization and query expansion
- **Bilingual NLP** — English (scispaCy) + Japanese (GiNZA/ja_ginza_electra) via Python sidecar
- **MCP Server** — 14 tools for AIRA integration via stdio transport
- **CLI** — 8 commands for local operation and batch processing
- **Graceful Degradation** — BM25 fallback, symbolic canonicalization, template responses when LLM/embedding unavailable

## 📐 Architecture

### Layer Diagram

```
┌─────────────────────────────────────────────────┐
│  Interface Layer                                │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ MCP (14) │  │ CLI (8)  │  │   Runtime/DI  │  │
│  └────┬─────┘  └────┬─────┘  └───────┬───────┘  │
├───────┼──────────────┼────────────────┼──────────┤
│  Application Layer                              │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ Indexing │  │  Query   │  │ Dict/Thesaurus│  │
│  │ Stage    │  │ Service  │  │   Services    │  │
│  │ I–IV     │  │ PPR+LLM  │  │               │  │
│  └────┬─────┘  └────┬─────┘  └───────┬───────┘  │
├───────┼──────────────┼────────────────┼──────────┤
│  Domain Layer (Ports)                           │
│  Memory │ Agent │ Dictionary │ Retrieval │ Storage │
├─────────────────────────────────────────────────┤
│  Infrastructure Layer (Adapters)                │
│  SQLite │ VectorIndex │ OpenAI │ NLP Sidecar    │
└─────────────────────────────────────────────────┘
```

Four-layer architecture (Domain / Application / Infrastructure / Interface) with strict dependency inversion. The Domain layer has zero dependencies on concrete implementations.

### Data Flow

```
AIRA ──(ToolUniverse)──▶ PDF
                          │
                     markitdown
                          │
                          ▼
                      Markdown
                          │
                    MCP (stdio)
                          │
                          ▼
               ┌─MemGraphRAG──────────────────────┐
               │  Stage I   : Extract entities     │
               │  Stage II  : Canonicalize schemas  │
               │  Stage III : Detect conflicts     │
               │  Stage IV  : Project graph        │
               │                                   │
               │  Query: PPR → Context → LLM → Answer│
               └───────────────────────────────────┘
```

### Paper Algorithm Mapping

| Paper Concept | Implementation |
|---------------|----------------|
| Algorithm 1 Stage I (Composite Extraction) | `StageIExtractor` + `DictionaryBoostPipeline` |
| Algorithm 1 Stage II (Schema Filter) | `StageIICanonicalizer` + `ThesaurusNormalizationPipeline` |
| Algorithm 1 Stage III (Conflict Detection/Resolution) | `StageIIIConflictPipeline` + `ThesaurusConflictSignals` |
| Algorithm 1 Stage IV (Graph Projection) | `StageIVGraphProjector` + `ThesaurusGraphExpansion` |
| Equations 6-8 (Node Initialization) | `INodeInitializer` |
| Equations 9-12 (Φ/Ψ Mappings) | `IMemoryStore` + SQLite foreign keys |
| PPR v^(k+1) = (1-λ)·W·v^(k) + λ·v^(0) | `IPPR` |
| Hub Suppression log(deg+2) | `IGraphProjection` |

## 🚀 Quick Start

### Prerequisites

- **Node.js** ≥ 20
- **Python 3** (optional — for NLP sidecar with scispaCy/GiNZA)

### Installation

```bash
# Clone and install
git clone https://github.com/nahisaho/aira-synapse.git
cd aira-synapse
npm install

# Build
npm run build --workspace=packages/memgraphrag

# (Optional) Install Python NLP dependencies
pip install -r packages/memgraphrag/python/sidecar/requirements.txt
```

### First Use

```bash
# 1. Generate default config
npx memgraphrag init --output ./memgraphrag.yml

# 2. (Optional) Set API key for LLM/embedding — see "Configuration" for details
export OPENAI_API_KEY="sk-..."

# 3. Index markdown files into a corpus
npx memgraphrag index \
  --corpus-id my-research \
  --input ./papers/ \
  --config ./memgraphrag.yml

# 4. Query the knowledge graph
npx memgraphrag query \
  --corpus-id my-research \
  --query "What is the relationship between transformers and attention?" \
  --top-k 10 \
  --json
```

> **Note:** MemGraphRAG works without an API key. In local-only mode it uses BM25 lexical search, regex NLP, and template responses.

## 🔌 Interfaces

MemGraphRAG provides two mutually exclusive interfaces for different use cases.

### MCP Server (for AIRA Integration)

Runs as an MCP stdio server for [AIRA](https://github.com/nahisaho/aira). AIRA's ToolUniverse retrieves papers, markitdown converts them to Markdown, and MCP passes them to MemGraphRAG for knowledge graph construction.

**Setup** — add to your AIRA MCP config:

```json
{
  "mcpServers": {
    "memgraphrag": {
      "command": "node",
      "args": ["packages/memgraphrag/dist/interface/mcp/server.js"],
      "env": {
        "MEMGRAPHRAG_CONFIG": "packages/memgraphrag/config/default.memgraphrag.yml"
      }
    }
  }
}
```

> API key is loaded from `config/openai_api_key` by default. Set `OPENAI_API_KEY` env var as an alternative.

**Available Tools (14)**

| Category | Tool | Description |
|----------|------|-------------|
| Corpus | `create_corpus` | Create a new corpus |
| | `delete_corpus` | Delete corpus with cascade |
| | `list_corpora` | List all corpora |
| Indexing | `index_documents` | Index markdown documents (async job) |
| | `get_job_status` | Check indexing job status |
| | `cancel_job` | Cancel a running job |
| | `delete_document` | Delete a document and recompute |
| Query | `query` | Query with PPR + citations |
| | `get_stats` | Get corpus statistics |
| Lexicon | `manage_dictionary` | CRUD for term dictionary |
| | `manage_thesaurus` | CRUD for thesaurus relations |
| | `build_dictionary_from_api` | Build dictionary from Semantic Scholar |
| Analysis | `analyze_conflicts` | Analyze fact conflicts |
| | `export_graph` | Export graph (JSON/GraphML) |

### CLI (for Local Operation)

| Command | Description |
|---------|-------------|
| `memgraphrag init` | Generate default config file |
| `memgraphrag index` | Index markdown documents |
| `memgraphrag query` | Query the knowledge graph |
| `memgraphrag stats` | Show corpus statistics |
| `memgraphrag dictionary` | Manage term dictionary (build/import/export/stats) |
| `memgraphrag thesaurus` | Manage thesaurus (import/export/lookup/stats) |
| `memgraphrag visualize` | Export graph as GraphML/JSON |
| `memgraphrag conflicts` | Analyze and display conflicts |

All commands support `--json` for machine-readable output.

### aira-graphdb Direct Tools (for High-Performance Indexing)

Standalone scripts for direct document ingestion into [aira-graphdb](https://github.com/nahisaho/aira-graphdb) (Rust-based graph store). Bypasses SQLite for maximum throughput.

```bash
# Ingest markdown documents
node scripts/agdb-ingest.mjs <corpus-dir> --corpus <id> [--db <path>] \
     [--skip-vector] [--skip-lexical] [--concurrency <N>]

# Rebuild vector or lexical index
node scripts/agdb-index.mjs --corpus <id> --type <vector|lexical> [--db <path>]
```

**Requirements:**
- `npm run build` (scripts import from `dist/`)
- `OPENAI_API_KEY` environment variable
- `AIRA_GRAPHDB_NATIVE_CMD` pointing to the aira-graphdb binary, or
  `AIRA_GRAPHDB_REPO_PATH` pointing to an explicit aira-graphdb source checkout
  for the source-build fallback. The fallback does not guess paths from the
  current working directory.

**Features:**
- Document-scoped entity nodes (safe re-ingest without data loss)
- O_EXCL exclusive locking (concurrent access prevention)
- Memory snapshot merge (load → filter → concat → save)
- Batch mode for embeddings (50% cost reduction via OpenAI Batch API)

See [DES-AGDB-TOOL-001](../../spec/DES-AGDB-TOOL-001.md) for design details.

## ⚙️ Configuration Reference

All configuration is managed through a single YAML file (`memgraphrag.yml`) and optional environment variable overrides. See [`config/default.memgraphrag.yml`](config/default.memgraphrag.yml) for defaults.

### LLM / Embedding Providers

MemGraphRAG uses OpenAI-compatible APIs for text generation and embedding.

#### API Key Configuration

The API key is resolved in the following priority:

1. **Key file** (`providers.api_key_file` in config) — recommended for security
2. **Environment variable** (`OPENAI_API_KEY`)
3. **Empty** — triggers local-only / degraded mode automatically

```yaml
# memgraphrag.yml — recommended: store key in a file (never commit to git)
providers:
  api_key_file: ./config/openai_api_key
```

```bash
# Alternative: environment variable
export OPENAI_API_KEY="sk-..."
```

#### OpenAI (Default)

```yaml
providers:
  llm:
    backend: openai
    model: gpt-4o-mini
    temperature: 0.1
    max_tokens: 2048
  embedding:
    backend: openai
    model: text-embedding-3-large
    cache_dir: ./data/memgraphrag/cache/embeddings
    batch_mode: false                    # true: OpenAI Batch API (50% off, 24h SLA)
    batch_output_dir: ./data/memgraphrag/batch
```

#### Azure OpenAI

Set `api_key_file` or `OPENAI_API_KEY` to your Azure API key, then configure endpoints:

```yaml
providers:
  llm:
    backend: openai
    model: gpt-4o-mini                          # your deployment name
    base_url: https://YOUR_RESOURCE.openai.azure.com/openai/deployments/YOUR_DEPLOYMENT/v1
  embedding:
    backend: openai
    model: text-embedding-3-large               # your deployment name
    base_url: https://YOUR_RESOURCE.openai.azure.com/openai/deployments/YOUR_EMBEDDING/v1
```

#### Local / Self-hosted (Ollama, vLLM, etc.)

Any OpenAI-compatible endpoint works. Set `api_key_file` content to a dummy value if the server requires it.

```yaml
providers:
  llm:
    backend: openai
    model: llama3.1
    base_url: http://localhost:11434/v1          # Ollama
  embedding:
    backend: openai
    model: nomic-embed-text
    base_url: http://localhost:11434/v1
```

#### Local-Only Mode (No API Calls)

```yaml
local_only: true
```

Or via environment: `export MEMGRAPHRAG_LOCAL_ONLY=true`

Falls back to BM25 lexical search, regex-based NLP, and template responses.

#### Model Selection Guide

| Use Case | Recommended LLM | Recommended Embedding |
|----------|------------------|----------------------|
| High accuracy | `gpt-4o` | `text-embedding-3-large` |
| Cost-effective | `gpt-4o-mini` (default) | `text-embedding-3-small` |
| Privacy / offline | Ollama `llama3.1` | Ollama `nomic-embed-text` |
| Japanese focus | `gpt-4o` | `text-embedding-3-large` |

### NLP Providers

The NLP provider handles entity extraction and language detection via a Python subprocess.

```yaml
providers:
  nlp:
    backend: python-sidecar           # python-sidecar | regex | llm
    python_command: python3
    request_timeout_ms: 30000
    healthcheck_timeout_ms: 5000
```

| Backend | Requirements | Accuracy | Latency |
|---------|-------------|----------|---------|
| `python-sidecar` | Python 3 + scispaCy / GiNZA | High | Medium |
| `regex` | None | Low | Fast |
| `llm` | LLM API key | High | Slow |

### Algorithm Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `τ` (stabilization_threshold) | 2 | Schema frequency threshold for stable promotion |
| `δ` (similarity_threshold) | 0.8 | Conflict detection cosine similarity threshold |
| `δ_b` (bridging threshold) | 0.7 | Bridge edge similarity threshold |
| `λ` (teleport_probability) | 0.5 | PPR teleport probability |
| `α` (passage_damping) | 0.05 | Passage layer damping factor |
| `K` (top_k) | 10 | Top-K entities returned |
| `M` (top_m) | 5 | Top-M passages returned |
| `ε` (convergence_epsilon) | 1e-6 | PPR convergence threshold |

### Storage

```yaml
storage:
  backend: sqlite                     # sqlite | ladybug | neo4j | aira-graphdb
  sqlite_path: ./data/memgraphrag/memgraphrag.sqlite
  vector_index_dir: ./data/memgraphrag/vectors
  wal_mode: true                      # WAL for concurrent reads
  auto_migrate: true                  # auto-run schema migrations on startup
```

#### aira-graphdb Backend

[aira-graphdb](https://github.com/nahisaho/aira-graphdb) is a high-performance Rust sidecar with native vector search and Cypher query support.

```yaml
storage:
  backend: aira-graphdb
  aira_graphdb:
    db_path: ./data/memgraphrag/corpus.agdb   # JSON persistence file
```

For direct document ingestion (bypassing MCP/CLI), use the `agdb-ingest.mjs` and `agdb-index.mjs` scripts. EN HotpotQA benchmark: **89.6% accuracy** (vs Neo4j 88.4%).

### Security & Logging

```yaml
security:
  redact_stack_traces: true           # strip file paths from error messages
  corpus_isolation: strict            # prevent cross-corpus data leakage

logging:
  level: info                         # debug | info | warn | error
  audit_log_path: ./data/memgraphrag/audit.jsonl
  structured_log_path: ./data/memgraphrag/runtime.jsonl
```

### Environment Variable Overrides

Environment variables override YAML config values.

| Variable | Overrides |
|----------|-----------|
| `OPENAI_API_KEY` | API key for LLM and embedding providers |
| `MEMGRAPHRAG_CONFIG` | Path to YAML config file |
| `MEMGRAPHRAG_DATA_DIR` | `data_dir` in config |
| `MEMGRAPHRAG_LOCAL_ONLY` | `local_only` in config |
| `MEMGRAPHRAG_NLP_BACKEND` | `providers.nlp.backend` in config |
| `MEMGRAPHRAG_LOG_LEVEL` | `logging.level` in config |
| `MEMGRAPHRAG_BACKEND` | storage backend selection (`sqlite` / `ladybug` / `neo4j` / `aira-graphdb`) |
| `AIRA_GRAPHDB_DB_PATH` | Default DB path for agdb-ingest/agdb-index scripts |
| `AIRA_GRAPHDB_NATIVE_CMD` | Path to aira-graphdb-native binary |
| `AIRA_GRAPHDB_REPO_PATH` | Absolute aira-graphdb source checkout for the source-build fallback |

## 🏗️ Project Structure

```
packages/memgraphrag/
├── src/
│   ├── domain/              # Ports and domain models
│   │   ├── memory/          # Schema, Fact, Passage, GlobalMemory
│   │   ├── agent/           # Extraction, Conflict Detection/Resolution
│   │   ├── dictionary/      # ITermDictionary, IThesaurus
│   │   ├── retrieval/       # IMemoryFilter, IPPR, IContextBuilder
│   │   ├── storage/         # IGraphStore, IVectorIndex, IMemoryStore
│   │   └── provider/        # ILLMProvider, IEmbeddingProvider, INLPExtractor
│   ├── application/         # Use case orchestration
│   │   ├── corpus/          # CorpusManager
│   │   ├── indexing/        # Stage I–IV, AsyncJobRunner, Boost/Normalization
│   │   ├── query/           # QueryService, ContextBuilder, ThesaurusExpansion
│   │   ├── dictionary/      # DictionaryService, BuildFromApi
│   │   ├── thesaurus/       # ThesaurusService
│   │   ├── runtime/         # DegradedModePolicy
│   │   └── observability/   # MetricsCollector
│   ├── infrastructure/      # Adapters
│   │   ├── storage/         # SQLite, Neo4j, aira-graphdb stores, migrations
│   │   ├── llm/             # OpenAILLMProvider
│   │   ├── embedding/       # OpenAIEmbeddingProvider, BatchEmbeddingProvider
│   │   ├── nlp/             # PythonSidecarExtractor, RegexExtractor
│   │   ├── api/             # SemanticScholarClient/Cache
│   │   ├── retrieval/       # Bm25LexicalRetriever
│   │   ├── config/          # YAML config loader, env overlay
│   │   ├── logging/         # StructuredLogger, AuditLogger, MemorySampler
│   │   └── security/        # SecretMasker
│   └── interface/           # External boundaries
│       ├── mcp/             # MCP server, handlers, schema catalog
│       ├── cli/             # Commander.js commands
│       └── runtime/         # MemGraphRagRuntime (DI composition root)
├── python/sidecar/          # Python NLP sidecar (scispaCy + GiNZA)
├── scripts/                 # Batch tools (agdb-ingest, agdb-index, benchmarks)
├── config/                  # Default YAML config
├── docs/                    # AIRA MCP template and documentation
└── tests/                   # 88 test files, 527 tests
    ├── unit/
    ├── integration/
    ├── contract/
    └── benchmark/
```

## 🧪 Development

```bash
# Run tests
npm test --workspace=packages/memgraphrag

# Run tests in watch mode
npm run test:watch --workspace=packages/memgraphrag

# Build
npm run build --workspace=packages/memgraphrag

# Lint
npm run lint --workspace=packages/memgraphrag

# Run benchmarks
npx vitest bench --workspace=packages/memgraphrag
```

## 📚 References

- **Paper**: [*MemGraphRAG: Memory-based Multi-Agent System for Graph Retrieval-Augmented Generation*](https://arxiv.org/abs/2606.00610) (KDD 2026)
- **NLP**: [scispaCy](https://allenai.github.io/scispacy/) (English), [GiNZA](https://megagonlabs.github.io/ginza/) (Japanese)
- **Related work**: [altanative-lazygraphrag](https://qiita.com/hisaho/items/40b3042371067322ea81), [Domain Dictionary approach](https://qiita.com/hisaho/items/d8a8ed7d2022b9e60dc5)

## 📄 License

MIT
