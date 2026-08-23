# MemGraphRAG

**メモリベース・マルチエージェントシステムによるグラフ検索拡張生成**

[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3%2B-blue)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-527%20passing-brightgreen)]()
[![License](https://img.shields.io/badge/license-MIT-blue)]()

> KDD 2026 論文 [*"MemGraphRAG: Memory-based Multi-Agent System for Graph Retrieval-Augmented Generation"*](https://arxiv.org/abs/2606.00610) の実装。専門用語辞書・シソーラス正規化・GiNZA による日本語 NLP を統合し、高精度な学術文献 GraphRAG を実現する。

[English README](README.md)

---

## ✨ 特徴

- **三層グローバルメモリ** — オントロジー (M_ont)・ファクト (M_fac)・パッセージ (M_pas) と双方向マッピング Φ / Ψ
- **マルチエージェント・インデクシング** (Algorithm 1 Stage I–IV) — 複合抽出 → スキーマ正規化 → 衝突検出・解決 → グラフ射影 + ブリッジング
- **Personalized PageRank (PPR)** — λ=0.5 テレポート、ハブ抑制 log(deg+2)、収束判定
- **専門用語辞書** — 辞書ブーストによるエンティティ抽出精度向上、Semantic Scholar API からの自動構築
- **シソーラス正規化** — 同義語・上位語・下位語関係によるスキーマ正規化とクエリ拡張
- **日英バイリンガル NLP** — 英語 (scispaCy) + 日本語 (GiNZA/ja_ginza_electra) を Python サイドカーで提供
- **MCP サーバー** — 14 ツールで [AIRA](https://github.com/nahisaho/aira) と stdio 接続
- **CLI** — 8 コマンドでローカル運用・バッチ処理に対応
- **グレースフル・デグラデーション** — LLM/Embedding 不在時の BM25 フォールバック・シンボリック正規化・テンプレート応答

## 📐 アーキテクチャ

### レイヤー図

```
┌─────────────────────────────────────────────────┐
│  Interface Layer                                │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ MCP (14) │  │ CLI (8)  │  │   Runtime/DI  │  │
│  └────┬─────┘  └────┬─────┘  └───────┬───────┘  │
├───────┼──────────────┼────────────────┼──────────┤
│  Application Layer                              │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ Indexing │  │  Query   │  │  辞書/シソーラス  │  │
│  │ Stage    │  │ Service  │  │   サービス     │  │
│  │ I–IV     │  │ PPR+LLM  │  │               │  │
│  └────┬─────┘  └────┬─────┘  └───────┬───────┘  │
├───────┼──────────────┼────────────────┼──────────┤
│  Domain Layer（ポート）                          │
│  Memory │ Agent │ Dictionary │ Retrieval │ Storage │
├─────────────────────────────────────────────────┤
│  Infrastructure Layer（アダプター）               │
│  SQLite │ VectorIndex │ OpenAI │ NLP サイドカー    │
└─────────────────────────────────────────────────┘
```

4 層アーキテクチャ（Domain / Application / Infrastructure / Interface）で依存性逆転を徹底。Domain 層は一切の具象実装に依存しない。

### データフロー

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
               │  Stage I   : エンティティ抽出      │
               │  Stage II  : スキーマ正規化        │
               │  Stage III : 衝突検出・解決        │
               │  Stage IV  : グラフ射影            │
               │                                   │
               │  Query: PPR → Context → LLM → 回答 │
               └───────────────────────────────────┘
```

### 論文アルゴリズムとの対応

| 論文の概念 | 実装 |
|-----------|------|
| Algorithm 1 Stage I（複合抽出） | `StageIExtractor` + `DictionaryBoostPipeline` |
| Algorithm 1 Stage II（スキーマフィルタ） | `StageIICanonicalizer` + `ThesaurusNormalizationPipeline` |
| Algorithm 1 Stage III（衝突検出・解決） | `StageIIIConflictPipeline` + `ThesaurusConflictSignals` |
| Algorithm 1 Stage IV（グラフ射影） | `StageIVGraphProjector` + `ThesaurusGraphExpansion` |
| 式 6-8（ノード初期化） | `INodeInitializer` |
| 式 9-12（Φ/Ψ マッピング） | `IMemoryStore` + SQLite 外部キー |
| PPR v^(k+1) = (1-λ)·W·v^(k) + λ·v^(0) | `IPPR` |
| Hub Suppression log(deg+2) | `IGraphProjection` |

## 🚀 クイックスタート

### 前提条件

- **Node.js** ≥ 20
- **Python 3**（オプション — scispaCy/GiNZA による NLP サイドカー用）

### インストール

```bash
# クローンとインストール
git clone https://github.com/nahisaho/aira-synapse.git
cd aira-synapse
npm install

# ビルド
npm run build --workspace=packages/memgraphrag

# (オプション) Python NLP 依存のインストール
pip install -r packages/memgraphrag/python/sidecar/requirements.txt
```

### はじめて使う

```bash
# 1. デフォルト設定ファイルを生成
npx memgraphrag init --output ./memgraphrag.yml

# 2. (オプション) LLM/Embedding 用の API キーを設定 — 詳細は「設定リファレンス」参照
export OPENAI_API_KEY="sk-..."

# 3. Markdown ファイルをコーパスにインデクシング
npx memgraphrag index \
  --corpus-id my-research \
  --input ./papers/ \
  --config ./memgraphrag.yml

# 4. ナレッジグラフにクエリ
npx memgraphrag query \
  --corpus-id my-research \
  --query "Transformer と Attention の関係は？" \
  --top-k 10 \
  --json
```

> **Note:** API キーなしでも動作します。ローカルオンリーモードでは BM25 語彙検索、正規表現 NLP、テンプレート応答を使用します。

## 🔌 インターフェース

MemGraphRAG は用途に応じて 2 つのインターフェースを提供する。

### MCP サーバー（AIRA 連携用）

[AIRA](https://github.com/nahisaho/aira) の MCP stdio サーバーとして動作。AIRA の ToolUniverse で取得した論文を markitdown で Markdown に変換し、MCP 経由で MemGraphRAG に渡してナレッジグラフを構築する。

**セットアップ** — AIRA の MCP 設定に追加：

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

> API キーはデフォルトで `config/openai_api_key` から読み込まれる。代替として `OPENAI_API_KEY` 環境変数も使用可能。

**ツール一覧（14 ツール）**

| カテゴリ | ツール | 説明 |
|---------|--------|------|
| コーパス | `create_corpus` | 新規コーパスを作成 |
| | `delete_corpus` | コーパスをカスケード削除 |
| | `list_corpora` | 全コーパスを一覧表示 |
| インデクシング | `index_documents` | Markdown ドキュメントをインデクシング（非同期ジョブ） |
| | `get_job_status` | インデクシングジョブの状態を確認 |
| | `cancel_job` | 実行中のジョブをキャンセル |
| | `delete_document` | ドキュメントを削除して再計算 |
| クエリ | `query` | PPR + 引用付きクエリ |
| | `get_stats` | コーパス統計情報を取得 |
| 辞書 | `manage_dictionary` | 専門用語辞書の CRUD |
| | `manage_thesaurus` | シソーラス関係の CRUD |
| | `build_dictionary_from_api` | Semantic Scholar から辞書を自動構築 |
| 分析 | `analyze_conflicts` | ファクト衝突を分析 |
| | `export_graph` | グラフをエクスポート（JSON/GraphML） |

### CLI（ローカル運用用）

| コマンド | 説明 |
|---------|------|
| `memgraphrag init` | デフォルト設定ファイルを生成 |
| `memgraphrag index` | Markdown ドキュメントをインデクシング |
| `memgraphrag query` | ナレッジグラフにクエリ |
| `memgraphrag stats` | コーパス統計情報を表示 |
| `memgraphrag dictionary` | 専門用語辞書を管理（build/import/export/stats） |
| `memgraphrag thesaurus` | シソーラスを管理（import/export/lookup/stats） |
| `memgraphrag visualize` | グラフを GraphML/JSON でエクスポート |
| `memgraphrag conflicts` | 衝突を分析・表示 |

全コマンドで `--json` オプションにより機械可読な JSON 出力に対応。

### aira-graphdb 直接ツール（高速インデクシング用）

[aira-graphdb](https://github.com/nahisaho/aira-graphdb)（Rust製グラフストア）へ直接ドキュメントを登録するスクリプト。SQLite を経由せず最大スループットを実現。

```bash
# ドキュメント登録
node scripts/agdb-ingest.mjs <corpus-dir> --corpus <id> [--db <path>] \
     [--skip-vector] [--skip-lexical] [--concurrency <N>]

# ベクトル/レキシカルインデクス再構築
node scripts/agdb-index.mjs --corpus <id> --type <vector|lexical> [--db <path>]
```

**必要環境:**
- `npm run build`（スクリプトは `dist/` からインポート）
- `OPENAI_API_KEY` 環境変数
- `AIRA_GRAPHDB_NATIVE_CMD` で aira-graphdb バイナリを指定するか、ソースから
  ビルドする場合は `AIRA_GRAPHDB_REPO_PATH` で明示的な aira-graphdb checkout を指定
  （カレントディレクトリからの自動推測は行わない）

**機能:**
- ドキュメントスコープのエンティティノード（再登録時のデータ損失防止）
- O_EXCL 排他ロック（同時アクセス防止）
- メモリスナップショットのマージ（load → filter → concat → save）
- エンベディングのバッチモード（OpenAI Batch API で 50% コスト削減）

## ⚙️ 設定リファレンス

すべての設定は単一の YAML ファイル（`memgraphrag.yml`）と環境変数オーバーライドで管理する。デフォルト値は [`config/default.memgraphrag.yml`](config/default.memgraphrag.yml) を参照。

### LLM / Embedding プロバイダー

MemGraphRAG は OpenAI 互換 API をテキスト生成とエンベディングに使用する。

#### API キーの設定

API キーは以下の優先順位で解決される：

1. **キーファイル**（設定の `providers.api_key_file`）— セキュリティ上推奨
2. **環境変数**（`OPENAI_API_KEY`）
3. **未設定** — ローカルオンリー / デグラデーションモードに自動切替

```yaml
# memgraphrag.yml — 推奨: キーをファイルに保存（git にコミットしないこと）
providers:
  api_key_file: ./config/openai_api_key
```

```bash
# 代替: 環境変数
export OPENAI_API_KEY="sk-..."
```

#### OpenAI（デフォルト）

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
    batch_mode: false                    # true: OpenAI Batch API（50%コスト削減、24時間SLA）
    batch_output_dir: ./data/memgraphrag/batch
```

#### Azure OpenAI

`api_key_file` または `OPENAI_API_KEY` に Azure API キーを設定し、エンドポイントを指定：

```yaml
providers:
  llm:
    backend: openai
    model: gpt-4o-mini                          # デプロイメント名
    base_url: https://YOUR_RESOURCE.openai.azure.com/openai/deployments/YOUR_DEPLOYMENT/v1
  embedding:
    backend: openai
    model: text-embedding-3-large               # デプロイメント名
    base_url: https://YOUR_RESOURCE.openai.azure.com/openai/deployments/YOUR_EMBEDDING/v1
```

#### ローカル / セルフホスト（Ollama, vLLM 等）

OpenAI 互換エンドポイントであれば何でも利用可能。サーバーが要求する場合は `api_key_file` にダミー値を設定する。

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

#### ローカルオンリーモード（API 呼び出しなし）

```yaml
local_only: true
```

環境変数でも可：`export MEMGRAPHRAG_LOCAL_ONLY=true`

BM25 語彙検索、正規表現ベース NLP、テンプレート応答にフォールバックする。

#### モデル選択ガイド

| ユースケース | 推奨 LLM | 推奨エンベディング |
|-------------|----------|-------------------|
| 高精度 | `gpt-4o` | `text-embedding-3-large` |
| コスト重視 | `gpt-4o-mini`（デフォルト） | `text-embedding-3-small` |
| プライバシー / オフライン | Ollama `llama3.1` | Ollama `nomic-embed-text` |
| 日本語特化 | `gpt-4o` | `text-embedding-3-large` |

### NLP プロバイダー

NLP プロバイダーはエンティティ抽出と言語検出を Python サブプロセス経由で処理する。

```yaml
providers:
  nlp:
    backend: python-sidecar           # python-sidecar | regex | llm
    python_command: python3
    request_timeout_ms: 30000
    healthcheck_timeout_ms: 5000
```

| バックエンド | 必要環境 | 精度 | レイテンシ |
|-------------|---------|------|----------|
| `python-sidecar` | Python 3 + scispaCy / GiNZA | 高 | 中 |
| `regex` | なし | 低 | 高速 |
| `llm` | LLM API キー | 高 | 低速 |

### アルゴリズムパラメータ

| パラメータ | デフォルト | 説明 |
|-----------|---------|------|
| `τ` (stabilization_threshold) | 2 | スキーマ安定化の頻度しきい値 |
| `δ` (similarity_threshold) | 0.8 | 衝突検出のコサイン類似度しきい値 |
| `δ_b` (bridging threshold) | 0.7 | ブリッジエッジの類似度しきい値 |
| `λ` (teleport_probability) | 0.5 | PPR テレポート確率 |
| `α` (passage_damping) | 0.05 | パッセージ層の減衰係数 |
| `K` (top_k) | 10 | 返却するエンティティ数 |
| `M` (top_m) | 5 | 返却するパッセージ数 |
| `ε` (convergence_epsilon) | 1e-6 | PPR 収束しきい値 |

### ストレージ

```yaml
storage:
  sqlite_path: ./data/memgraphrag/memgraphrag.sqlite
  vector_index_dir: ./data/memgraphrag/vectors
  wal_mode: true                      # WAL で並行読み取りを高速化
  auto_migrate: true                  # 起動時にスキーママイグレーションを自動実行
```

### セキュリティ & ロギング

```yaml
security:
  redact_stack_traces: true           # エラーメッセージからファイルパスを除去
  corpus_isolation: strict            # コーパス間のデータ漏洩を防止

logging:
  level: info                         # debug | info | warn | error
  audit_log_path: ./data/memgraphrag/audit.jsonl
  structured_log_path: ./data/memgraphrag/runtime.jsonl
```

### 環境変数オーバーライド

環境変数は YAML 設定値を上書きする。

| 変数 | 上書き対象 |
|------|-----------|
| `OPENAI_API_KEY` | LLM / Embedding プロバイダーの API キー |
| `MEMGRAPHRAG_CONFIG` | YAML 設定ファイルのパス |
| `MEMGRAPHRAG_DATA_DIR` | 設定ファイルの `data_dir` |
| `MEMGRAPHRAG_LOCAL_ONLY` | 設定ファイルの `local_only` |
| `MEMGRAPHRAG_NLP_BACKEND` | 設定ファイルの `providers.nlp.backend` |
| `MEMGRAPHRAG_LOG_LEVEL` | 設定ファイルの `logging.level` |
| `AIRA_GRAPHDB_REPO_PATH` | ソースビルド用 aira-graphdb checkout の絶対パス |

## 🏗️ プロジェクト構成

```
packages/memgraphrag/
├── src/
│   ├── domain/              # ポートとドメインモデル
│   │   ├── memory/          # Schema, Fact, Passage, GlobalMemory
│   │   ├── agent/           # 抽出、衝突検出・解決
│   │   ├── dictionary/      # ITermDictionary, IThesaurus
│   │   ├── retrieval/       # IMemoryFilter, IPPR, IContextBuilder
│   │   ├── storage/         # IGraphStore, IVectorIndex, IMemoryStore
│   │   └── provider/        # ILLMProvider, IEmbeddingProvider, INLPExtractor
│   ├── application/         # ユースケース・オーケストレーション
│   │   ├── corpus/          # CorpusManager
│   │   ├── indexing/        # Stage I–IV, AsyncJobRunner, ブースト/正規化
│   │   ├── query/           # QueryService, ContextBuilder, シソーラス拡張
│   │   ├── dictionary/      # DictionaryService, API 自動構築
│   │   ├── thesaurus/       # ThesaurusService
│   │   ├── runtime/         # DegradedModePolicy
│   │   └── observability/   # MetricsCollector
│   ├── infrastructure/      # アダプター
│   │   ├── storage/         # SQLite ストア, FileVectorIndex, マイグレーション
│   │   ├── llm/             # OpenAILLMProvider
│   │   ├── embedding/       # OpenAIEmbeddingProvider
│   │   ├── nlp/             # PythonSidecarExtractor, RegexExtractor
│   │   ├── api/             # SemanticScholarClient/Cache
│   │   ├── retrieval/       # Bm25LexicalRetriever
│   │   ├── config/          # YAML 設定ローダー、環境変数オーバーレイ
│   │   ├── logging/         # StructuredLogger, AuditLogger, MemorySampler
│   │   └── security/        # SecretMasker
│   └── interface/           # 外部境界
│       ├── mcp/             # MCP サーバー、ハンドラー、スキーマカタログ
│       ├── cli/             # Commander.js コマンド
│       └── runtime/         # MemGraphRagRuntime（DI 合成ルート）
├── python/sidecar/          # Python NLP サイドカー（scispaCy + GiNZA）
├── config/                  # デフォルト YAML 設定
├── docs/                    # AIRA MCP テンプレートとドキュメント
├── scripts/                 # バッチツール（agdb-ingest, agdb-index, ベンチマーク）
├── config/                  # デフォルト YAML 設定
├── docs/                    # AIRA MCP テンプレートとドキュメント
└── tests/                   # 88 テストファイル、527 テスト
    ├── unit/                # ユニットテスト
    ├── integration/         # 統合テスト
    ├── contract/            # コントラクトテスト
    └── benchmark/           # ベンチマーク
```

## 🧪 開発

```bash
# テスト実行
npm test --workspace=packages/memgraphrag

# ウォッチモード
npm run test:watch --workspace=packages/memgraphrag

# ビルド
npm run build --workspace=packages/memgraphrag

# リント
npm run lint --workspace=packages/memgraphrag

# ベンチマーク
npx vitest bench --workspace=packages/memgraphrag
```

## 📚 参考文献

- **論文**: [*MemGraphRAG: Memory-based Multi-Agent System for Graph Retrieval-Augmented Generation*](https://arxiv.org/abs/2606.00610) (KDD 2026)
- **NLP**: [scispaCy](https://allenai.github.io/scispacy/)（英語）、[GiNZA](https://megagonlabs.github.io/ginza/)（日本語）
- **関連知見**: [altanative-lazygraphrag の知見](https://qiita.com/hisaho/items/40b3042371067322ea81)、[専門用語辞書アプローチ](https://qiita.com/hisaho/items/d8a8ed7d2022b9e60dc5)

## 📄 ライセンス

MIT
