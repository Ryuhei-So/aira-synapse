# aira-synapse

**Graph RAG engine for academic papers** — achieving 91.2% accuracy on HotpotQA (multi-hop QA benchmark), +19.6pt over the original MemGraphRAG paper.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.3+-blue)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> 🇯🇵 [日本語版 README はこちら](README-ja.md)

## What is aira-synapse?

aira-synapse is a **MemGraphRAG clean-room implementation** with proprietary extensions, designed to extract knowledge from academic papers via multi-hop reasoning. It uses a three-layer memory architecture, multi-agent fact extraction, and hybrid retrieval (Vector + BM25 RRF).

### Key Features

- **91.2% LLM-Acc** on HotpotQA 500 questions (paper baseline: 71.6%)
- **78.3% JA accuracy** with GPT-5.5 (Comparison: 90.7%, surpassing EN)
- **Hybrid retrieval**: Vector + BM25 with Reciprocal Rank Fusion
- **Three-layer memory**: Episodic → Semantic → Procedural with schema stabilization
- **Multi-agent extraction**: Schema Agent + Contradiction Detector + Quality Gate
- **MCP integration**: Connect to Claude Desktop / VS Code Copilot
- **Japanese support**: GINZA-based sentence chunking for JA corpora
- **Zero Docker dependency**: Runs on pure [aira-graphdb](https://github.com/nahisaho/aira-graphdb) (.agdb + .vblob)

## Benchmark Results

| Language | Model | Str-Acc | LLM-Acc | vs Paper |
|----------|-------|---------|---------|----------|
| EN | GPT-5.4-mini | 89.4% (447/500) | **91.2%** (456/500) | **+19.6pt** |
| JA | GPT-5.4-mini | 70.8% (283/400) | 70.8% | baseline |
| JA | GPT-5.5 | **78.3%** (313/400) | 78.3% | +7.5pt |

> Paper: MemGraphRAG (KDD 2026, Xiang et al.) — GPT-4o-mini Str-Acc 67.2%, LLM-Acc 71.6%

## Prerequisites

- **Rust toolchain** (`rustup`) — for building aira-graphdb
- **Node.js 20+** / npm
- **Docling** (IBM) — PDF → Markdown conversion
- **OpenAI API key** — for LLM and embeddings

## Quick Start

```bash
# 1. Build aira-graphdb (Rust graph DB)
git clone https://github.com/nahisaho/aira-graphdb.git
cd aira-graphdb && cargo build --release
# Add to PATH or: cp target/release/aira-graphdb /usr/local/bin/

# 2. Setup aira-synapse (Graph RAG engine)
git clone https://github.com/nahisaho/aira-synapse.git
cd aira-synapse && npm install && npm run build

# 3. Index papers into knowledge graph
export OPENAI_API_KEY=your-key-here
npx aira-synapse index --input ./your-papers/*.pdf

# 4. Start MCP server for Claude Desktop / VS Code Copilot
npx aira-synapse mcp --db ./your-research.agdb
```

## Architecture

```
┌─────────────────────────────────────────────────────┐
│ Interface Layer (CLI / MCP Server)                  │
├─────────────────────────────────────────────────────┤
│ Application Layer                                   │
│   IndexingPipeline → QueryService → AnswerGenerator │
├─────────────────────────────────────────────────────┤
│ Domain Layer                                        │
│   ThreeLayerMemory │ SchemaStabilizer │ PPR Walker  │
├─────────────────────────────────────────────────────┤
│ Infrastructure Layer                                │
│   aira-graphdb │ OpenAI │ Docling │ GINZA           │
└─────────────────────────────────────────────────────┘
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `aira-synapse init` | Initialize a new knowledge base |
| `aira-synapse index` | Index PDF/Markdown documents |
| `aira-synapse query` | Query the knowledge graph |
| `aira-synapse stats` | Show graph statistics |
| `aira-synapse mcp` | Start MCP server |
| `aira-synapse visualize` | Visualize graph structure |
| `aira-synapse conflicts` | Show detected contradictions |
| `aira-synapse dictionary` | Manage domain dictionary |
| `aira-synapse thesaurus` | Manage thesaurus |

## Project Structure

```
packages/
  memgraphrag/          # Core Graph RAG engine
    src/
      domain/           # Domain models, interfaces
      application/      # Use cases (indexing, query)
      infrastructure/   # Adapters (aira-graphdb, OpenAI, GINZA)
      interface/cli/    # Commander.js CLI
    config/             # Configuration (YAML)
    data/benchmark/     # HotpotQA benchmark data & results
    scripts/            # Benchmark & utility scripts
docs/                   # Articles and documentation
```

## Configuration

Edit `packages/memgraphrag/config/default.memgraphrag.yml`:

```yaml
llm:
  provider: openai
  model: gpt-5.4-mini        # or gpt-5.5 for higher accuracy
  reasoning_effort: high
  verbosity: low

retrieval:
  hybrid: true                # Vector + BM25 RRF
  topK: 10
  topM: 10
  contextLimit: 3000

graph:
  hubNodes: 50                # PPR hub count
```

## Related Projects

- [aira-graphdb](https://github.com/nahisaho/aira-graphdb) — Rust-based embedded graph DB with native HNSW vector index
- [aira](https://github.com/nahisaho/aira) — ToolUniverse agent for paper acquisition

## References

- Xiang et al., 2026. *MemGraphRAG: Memory-based Multi-Agent System for Graph RAG*. KDD 2026. [arXiv:2606.00610](https://arxiv.org/abs/2606.00610)
- Edge et al., 2024. *From Local to Global: A Graph RAG Approach*. [arXiv:2404.16130](https://arxiv.org/abs/2404.16130)
- Yang et al., 2018. *HotpotQA: A Dataset for Diverse Multi-hop QA*. [hotpotqa.github.io](https://hotpotqa.github.io/)

## License

MIT

## Contributing

Issues, PRs, and Stars welcome! Especially **accuracy reports on your own research corpus** — they help generalize across languages and domains.
