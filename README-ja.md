# aira-synapse

**学術論文のための Graph RAG エンジン** — HotpotQA（マルチホップ QA ベンチマーク）で精度 91.2% を達成。原論文 MemGraphRAG 比 +19.6pt。

[![TypeScript](https://img.shields.io/badge/TypeScript-5.3+-blue)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> 🇺🇸 [English README](README.md)

## aira-synapse とは

aira-synapse は **MemGraphRAG（KDD 2026）のクリーンルーム実装 + 独自拡張** です。学術論文からマルチホップ推論で知識を抽出するために設計されており、三層メモリアーキテクチャ、マルチエージェント Fact 抽出、ハイブリッド検索（Vector + BM25 RRF）を使用します。

### 主な特長

- **91.2% LLM-Acc** — HotpotQA 500問（論文ベースライン: 71.6%）
- **日本語 78.3%** — GPT-5.5 使用。Comparison 90.7% で英語版を超過
- **ハイブリッド検索**: Vector + BM25 を Reciprocal Rank Fusion で統合
- **三層メモリ**: Episodic → Semantic → Procedural + スキーマ安定化
- **マルチエージェント抽出**: Schema Agent + 矛盾検出 + 品質ゲート
- **MCP 統合**: Claude Desktop / VS Code Copilot から自然言語で質問
- **日本語対応**: GINZA sentencizer による文単位チャンキング
- **Docker 不要**: [aira-graphdb](https://github.com/nahisaho/aira-graphdb) の .agdb + .vblob 2ファイルで完結

## ベンチマーク結果

| 言語 | モデル | Str-Acc | LLM-Acc | vs 論文 |
|------|--------|---------|---------|---------|
| EN | GPT-5.4-mini | 89.4% (447/500) | **91.2%** (456/500) | **+19.6pt** |
| JA | GPT-5.4-mini | 70.8% (283/400) | 70.8% | ベースライン |
| JA | GPT-5.5 | **78.3%** (313/400) | 78.3% | +7.5pt |

> 論文: MemGraphRAG (KDD 2026, Xiang et al.) — GPT-4o-mini Str-Acc 67.2%, LLM-Acc 71.6%

## 前提条件

- **Rust toolchain** (`rustup`) — aira-graphdb のビルドに必要
- **Node.js 20+** / npm
- **Docling** (IBM) — PDF → Markdown 変換
- **OpenAI API キー** — LLM と Embedding に使用

## クイックスタート

```bash
# 1. aira-graphdb (Rust 製グラフ DB) をビルド
git clone https://github.com/nahisaho/aira-graphdb.git
cd aira-graphdb && cargo build --release
# PATH に追加（または cp target/release/aira-graphdb /usr/local/bin/）

# 2. aira-synapse (Graph RAG エンジン) をセットアップ
git clone https://github.com/nahisaho/aira-synapse.git
cd aira-synapse && npm install && npm run build

# 3. 論文 PDF を投入してナレッジグラフ構築
export OPENAI_API_KEY=your-key-here
npx aira-synapse index --input ./your-papers/*.pdf

# 4. MCP サーバーを起動して Claude Desktop / VS Code Copilot に接続
npx aira-synapse mcp --db ./your-research.agdb
```

## アーキテクチャ

```
┌─────────────────────────────────────────────────────┐
│ Interface Layer (CLI / MCP Server)                   │
├─────────────────────────────────────────────────────┤
│ Application Layer                                    │
│   IndexingPipeline → QueryService → AnswerGenerator │
├─────────────────────────────────────────────────────┤
│ Domain Layer                                         │
│   ThreeLayerMemory │ SchemaStabilizer │ PPR Walker  │
├─────────────────────────────────────────────────────┤
│ Infrastructure Layer                                 │
│   aira-graphdb │ OpenAI │ Docling │ GINZA          │
└─────────────────────────────────────────────────────┘
```

## CLI コマンド

| コマンド | 説明 |
|---------|------|
| `aira-synapse init` | ナレッジベースを初期化 |
| `aira-synapse index` | PDF/Markdown ドキュメントをインデックス |
| `aira-synapse query` | ナレッジグラフに質問 |
| `aira-synapse stats` | グラフ統計を表示 |
| `aira-synapse mcp` | MCP サーバーを起動 |
| `aira-synapse visualize` | グラフ構造を可視化 |
| `aira-synapse conflicts` | 検出された矛盾を表示 |
| `aira-synapse dictionary` | 専門用語辞書を管理 |
| `aira-synapse thesaurus` | シソーラスを管理 |

## プロジェクト構成

```
packages/
  memgraphrag/          # コア Graph RAG エンジン
    src/
      domain/           # ドメインモデル、インターフェース
      application/      # ユースケース（インデキシング、クエリ）
      infrastructure/   # アダプター（aira-graphdb, OpenAI, GINZA）
      interface/cli/    # Commander.js CLI
    config/             # 設定ファイル（YAML）
    data/benchmark/     # HotpotQA ベンチマークデータ＆結果
    scripts/            # ベンチマーク・ユーティリティスクリプト
docs/                   # 記事・ドキュメント
```

## 設定

`packages/memgraphrag/config/default.memgraphrag.yml` を編集:

```yaml
llm:
  provider: openai
  model: gpt-5.4-mini        # 高精度が必要なら gpt-5.5
  reasoning_effort: high
  verbosity: low

retrieval:
  hybrid: true                # Vector + BM25 RRF
  topK: 10
  topM: 10
  contextLimit: 3000

graph:
  hubNodes: 50                # PPR ハブノード数
```

## 関連プロジェクト

- [aira-graphdb](https://github.com/nahisaho/aira-graphdb) — Rust 製組み込みグラフ DB（ネイティブ HNSW ベクトルインデックス付き）
- [aira](https://github.com/nahisaho/aira) — ToolUniverse エージェント（論文取得用）

## 参考文献

- Xiang et al., 2026. *MemGraphRAG: Memory-based Multi-Agent System for Graph RAG*. KDD 2026. [arXiv:2606.00610](https://arxiv.org/abs/2606.00610)
- Edge et al., 2024. *From Local to Global: A Graph RAG Approach*. [arXiv:2404.16130](https://arxiv.org/abs/2404.16130)
- Yang et al., 2018. *HotpotQA: A Dataset for Diverse Multi-hop QA*. [hotpotqa.github.io](https://hotpotqa.github.io/)

## ライセンス

MIT

## コントリビューション

Issue / PR / Star 歓迎！特に **自分の研究分野の論文コーパスでの精度報告** をいただけると、多言語・多分野への汎化に大きく貢献します。
