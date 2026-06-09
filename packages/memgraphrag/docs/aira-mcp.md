# MemGraphRAG MCP for AIRA

Use `docs/aira-mcp.template.json` as a starting point for AIRA project MCP settings.

## Environment variables

- `MEMGRAPHRAG_CONFIG`: Path to the MemGraphRAG YAML config file.
- `OPENAI_API_KEY`: Required when `local_only: false` and OpenAI-backed providers are enabled.
- `MEMGRAPHRAG_DATA_DIR`: Optional override for the runtime data directory.
- `MEMGRAPHRAG_SQLITE_PATH`: Optional override for the SQLite database path.
- `MEMGRAPHRAG_NLP_BACKEND`: Optional override (`python-sidecar`, `regex`, `llm`).
- `MEMGRAPHRAG_LOCAL_ONLY`: Optional boolean override for local-only mode.
- `MEMGRAPHRAG_LOG_LEVEL`: Optional logging override (`debug`, `info`, `warn`, `error`).

## Setup

1. Build the package: `npm run build` in `packages/memgraphrag`.
2. Copy `docs/aira-mcp.template.json` into your AIRA MCP config.
3. Set `OPENAI_API_KEY` if you use remote LLM or embedding providers.
4. Start AIRA and verify the `memgraphrag` server is listed in MCP tools.
