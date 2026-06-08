# アーキテクチャ構造 — aira-synapse

## パッケージ構成

`packages/memgraphrag/` 配下に単一パッケージ構成（将来的に分割可能な内部モジュール設計）。

```
packages/memgraphrag/
├── src/
│   ├── domain/           # ドメインモデル、インターフェース
│   │   ├── memory/       # Schema, Fact, Passage, GlobalMemory
│   │   ├── agent/        # ExtractionAgent, ConflictDetector, ConflictResolver
│   │   ├── dictionary/   # TermDictionary, Thesaurus
│   │   ├── retrieval/    # PPR, NodeInitializer, MemoryFilter, IGraphProjection
│   │   ├── storage/      # IGraphStore, IVectorIndex, IMemoryStore
│   │   └── provider/     # ILLMProvider, IEmbeddingProvider, INLPExtractor
│   ├── application/      # ユースケース、サービス
│   │   ├── indexing/     # IndexingService, AsyncJobRunner
│   │   ├── query/        # QueryService, ContextBuilder
│   │   ├── corpus/       # CorpusManager
│   │   ├── dictionary/   # DictionaryService
│   │   ├── thesaurus/    # ThesaurusService
│   │   └── runtime/      # DegradedModePolicy
│   ├── infrastructure/   # 外部アダプター
│   │   ├── storage/      # SQLiteGraphStore, SQLiteMemoryStore, SQLiteLexiconStore, FileVectorIndex
│   │   ├── llm/          # OpenAILLMProvider
│   │   ├── embedding/    # OpenAIEmbeddingProvider
│   │   ├── nlp/          # PythonSidecarExtractor, RegexExtractor
│   │   ├── retrieval/    # Bm25LexicalRetriever
│   │   ├── security/     # SecretMasker, ErrorRedactor
│   │   ├── config/       # YAML config loader
│   │   ├── logging/      # Structured logger, audit log
│   │   └── api/          # SemanticScholarClient
│   └── interface/
│       ├── mcp/          # MCP サーバー、ツールハンドラー、DTO adapter
│       ├── cli/          # Commander.js コマンド
│       └── runtime/      # MemGraphRagRuntime (DI composition root)
├── python/
│   └── sidecar/          # server.py, requirements.txt (scispaCy + GiNZA)
├── config/
│   └── default.memgraphrag.yml
└── tests/
    ├── unit/
    ├── integration/
    ├── contract/
    └── benchmark/
```

## 4層アーキテクチャ

| 層 | 責務 | 依存方向 |
|----|------|----------|
| **Domain** | ビジネスロジック、エンティティ、インターフェース定義 | 依存なし |
| **Application** | ユースケースオーケストレーション | → Domain |
| **Infrastructure** | 外部システムアダプター | → Domain |
| **Interface** | MCP / CLI エントリポイント | → Application |

## 依存性逆転

- Domain 層はインターフェースのみ定義（`IGraphStore`, `IVectorIndex`, `ILLMProvider` 等）
- Infrastructure 層が具象実装を提供
- Application 層が DI コンテナ経由で結合
- Interface 層の `MemGraphRagRuntime` が DI composition root を担当

## 設計パターン

| パターン | 適用箇所 |
|----------|----------|
| **Repository** | IGraphStore, IVectorIndex, IMemoryStore |
| **Strategy** | INLPExtractor, ILLMProvider, IEmbeddingProvider |
| **Observer** | Schema 状態遷移 → Fact 活性化カスケード |
| **Pipeline** | NLP → Dictionary Boost → Thesaurus Normalize |
| **Agent** | ExtractionAgent, ConflictDetectionAgent, ConflictResolutionAgent |
