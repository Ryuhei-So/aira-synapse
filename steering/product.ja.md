# プロダクトコンテキスト — aira-synapse

## ミッション

AIRA（AI Research Administrator）エコシステムにおけるナレッジグラフ構築・検索基盤を提供する。
論文・文献から構造化された知識を抽出し、研究者の問いに高精度で応答する。

## プロダクト

### MemGraphRAG

KDD 2026 論文 "MemGraphRAG: Memory-based Multi-Agent System for Graph Retrieval-Augmented Generation" に基づく GraphRAG システム。

**コアバリュー:**
- 三層グローバルメモリ（Ontology / Fact / Passage）による一貫したナレッジグラフ構築
- マルチエージェント（抽出 / 衝突検出 / 衝突解決）による品質保証
- 専門用語辞書・シソーラス辞書による学術ドメイン特化
- MCP サーバーとして AIRA から透過的に利用可能

## ターゲットユーザー

- AIRA を使う研究者・大学院生
- 大量の論文からナレッジグラフを構築したい研究チーム

## 連携システム

| システム | 役割 | リポジトリ |
|----------|------|-----------|
| **AIRA** | ホストアプリ（MCP クライアント） | nahisaho/aira |
| **ToolUniverse** | 89 科学 DB への論文検索 MCP | aira 内蔵 |
| **markitdown** | PDF → Markdown 変換 | microsoft/markitdown |
