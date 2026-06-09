# MemGraphRAG

**Memory-based Multi-Agent System for Graph Retrieval-Augmented Generation**

[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3%2B-blue)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-353%20passing-brightgreen)]()
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

## 🚀 Quick Start

### Prerequisites

- **Node.js** ≥ 20
- **Python 3** (optional, for NLP sidecar)
- **OpenAI API key** (optional, for LLM/embedding)

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

### Initialize Configuration

```bash
npx memgraphrag init --output ./memgraphrag.yml
```

### Index Documents

```bash
# Index markdown files into a corpus
npx memgraphrag index \
  --corpus-id my-research \
  --input ./papers/ \
  --config ./memgraphrag.yml
```

### Query

```bash
npx memgraphrag query \
  --corpus-id my-research \
  --query "What is the relationship between transformers and attention?" \
  --top-k 10 \
  --json
```

## 🔌 AIRA Integration (MCP)

MemGraphRAG runs as an MCP stdio server for [AIRA](https://github.com/nahisaho/aira).

### Setup

1. Copy the MCP template into your AIRA config:

```json
{
  "mcpServers": {
    "memgraphrag": {
      "command": "node",
      "args": ["packages/memgraphrag/dist/interface/mcp/server.js"],
      "env": {
        "MEMGRAPHRAG_CONFIG": "packages/memgraphrag/config/default.memgraphrag.yml",
        "OPENAI_API_KEY": "${OPENAI_API_KEY}"
      }
    }
  }
}
```

2. Set `OPENAI_API_KEY` in your environment.

### Available MCP Tools (14)

| Tool | Description |
|------|-------------|
| `create_corpus` | Create a new corpus |
| `delete_corpus` | Delete corpus with cascade |
| `list_corpora` | List all corpora |
| `index_documents` | Index markdown documents (async job) |
| `get_job_status` | Check indexing job status |
| `cancel_job` | Cancel a running job |
| `delete_document` | Delete a document and recompute |
| `query` | Query with PPR + citations |
| `get_stats` | Get corpus statistics |
| `manage_dictionary` | CRUD for term dictionary |
| `manage_thesaurus` | CRUD for thesaurus relations |
| `analyze_conflicts` | Analyze fact conflicts |
| `export_graph` | Export graph (JSON/GraphML) |
| `build_dictionary_from_api` | Build dictionary from Semantic Scholar |

## 🖥️ CLI Commands

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

## ⚙️ Configuration

See [`config/default.memgraphrag.yml`](config/default.memgraphrag.yml) for all options.

### Key Algorithm Parameters

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

### Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | OpenAI API key for LLM/embedding |
| `MEMGRAPHRAG_CONFIG` | Path to YAML config file |
| `MEMGRAPHRAG_DATA_DIR` | Override data directory |
| `MEMGRAPHRAG_LOCAL_ONLY` | Enable local-only mode (no API calls) |
| `MEMGRAPHRAG_NLP_BACKEND` | NLP backend: `python-sidecar` \| `regex` \| `llm` |
| `MEMGRAPHRAG_LOG_LEVEL` | Log level: `debug` \| `info` \| `warn` \| `error` |

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
│   │   ├── storage/         # SQLite stores, FileVectorIndex, migrations
│   │   ├── llm/             # OpenAILLMProvider
│   │   ├── embedding/       # OpenAIEmbeddingProvider
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
├── config/                  # Default YAML config
├── docs/                    # AIRA MCP template and documentation
└── tests/                   # 61 test files, 353 tests
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
