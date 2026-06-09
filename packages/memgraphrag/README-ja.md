# MemGraphRAG

**メモリベース・マルチエージェントシステムによるグラフ検索拡張生成**

[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3%2B-blue)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-353%20passing-brightgreen)]()
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

## 🚀 クイックスタート

### 前提条件

- **Node.js** ≥ 20
- **Python 3**（オプション、NLP サイドカー用）
- **OpenAI API キー**（オプション、LLM/Embedding 用）

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

### 設定ファイルの生成

```bash
npx memgraphrag init --output ./memgraphrag.yml
```

### ドキュメントのインデクシング

```bash
# Markdown ファイルをコーパスにインデクシング
npx memgraphrag index \
  --corpus-id my-research \
  --input ./papers/ \
  --config ./memgraphrag.yml
```

### クエリ

```bash
npx memgraphrag query \
  --corpus-id my-research \
  --query "Transformer と Attention の関係は？" \
  --top-k 10 \
  --json
```

## 🔌 AIRA 連携（MCP）

MemGraphRAG は [AIRA](https://github.com/nahisaho/aira) の MCP stdio サーバーとして動作する。AIRA の ToolUniverse で取得した論文を markitdown で Markdown に変換し、MCP 経由で MemGraphRAG に渡してナレッジグラフを構築する。

### セットアップ

1. MCP テンプレートを AIRA 設定にコピー：

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

2. 環境変数 `OPENAI_API_KEY` を設定する。

### MCP ツール一覧（14 ツール）

| ツール | 説明 |
|--------|------|
| `create_corpus` | 新規コーパスを作成 |
| `delete_corpus` | コーパスをカスケード削除 |
| `list_corpora` | 全コーパスを一覧表示 |
| `index_documents` | Markdown ドキュメントをインデクシング（非同期ジョブ） |
| `get_job_status` | インデクシングジョブの状態を確認 |
| `cancel_job` | 実行中のジョブをキャンセル |
| `delete_document` | ドキュメントを削除して再計算 |
| `query` | PPR + 引用付きクエリ |
| `get_stats` | コーパス統計情報を取得 |
| `manage_dictionary` | 専門用語辞書の CRUD |
| `manage_thesaurus` | シソーラス関係の CRUD |
| `analyze_conflicts` | ファクト衝突を分析 |
| `export_graph` | グラフをエクスポート（JSON/GraphML） |
| `build_dictionary_from_api` | Semantic Scholar から辞書を自動構築 |

## 🖥️ CLI コマンド

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

## ⚙️ 設定

[`config/default.memgraphrag.yml`](config/default.memgraphrag.yml) を参照。

### 主要アルゴリズムパラメータ

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

### 環境変数

| 変数 | 説明 |
|------|------|
| `OPENAI_API_KEY` | OpenAI API キー（LLM/Embedding 用） |
| `MEMGRAPHRAG_CONFIG` | YAML 設定ファイルのパス |
| `MEMGRAPHRAG_DATA_DIR` | データディレクトリのオーバーライド |
| `MEMGRAPHRAG_LOCAL_ONLY` | ローカルオンリーモード（API 呼び出しなし） |
| `MEMGRAPHRAG_NLP_BACKEND` | NLP バックエンド: `python-sidecar` \| `regex` \| `llm` |
| `MEMGRAPHRAG_LOG_LEVEL` | ログレベル: `debug` \| `info` \| `warn` \| `error` |

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
└── tests/                   # 61 テストファイル、353 テスト
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

## 📖 論文アルゴリズムとの対応

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

## 📚 参考文献

- **論文**: [*MemGraphRAG: Memory-based Multi-Agent System for Graph Retrieval-Augmented Generation*](https://arxiv.org/abs/2606.00610) (KDD 2026)
- **NLP**: [scispaCy](https://allenai.github.io/scispacy/)（英語）、[GiNZA](https://megagonlabs.github.io/ginza/)（日本語）
- **関連知見**: [altanative-lazygraphrag の知見](https://qiita.com/hisaho/items/40b3042371067322ea81)、[専門用語辞書アプローチ](https://qiita.com/hisaho/items/d8a8ed7d2022b9e60dc5)

## 📄 ライセンス

MIT
