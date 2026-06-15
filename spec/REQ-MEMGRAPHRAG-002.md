# MemGraphRAG v0.2.0 要件定義書 — LadybugDB ストレージ移行

**Document ID**: REQ-MEMGRAPHRAG-002
**Version**: 1.0
**Status**: Draft
**Created**: 2026-06-15
**Updated**: 2026-06-15
**Author**: GitHub Copilot (SDD Phase 1)
**Baseline**: v0.1.0 (MemGraphRAG v14, 83.6% HotpotQA)

---

## 1. 概要

### 1.1 目的

本ドキュメントは、MemGraphRAG v0.2.0 におけるストレージバックエンド移行の要件を定義する。
現行の SQLite + File-based Vector Index を **LadybugDB**（旧 Kuzu）に統合置換し、
以下の課題を解決する。

### 1.2 現状の課題

| 課題 | 現行実装 | 影響 |
|------|----------|------|
| ベクトル検索の低速 | FileVectorIndex (brute-force cosine) | 800K vectors で 1問 40s+ |
| グラフ操作の非効率 | SQLite JOIN + in-memory PPR (JS) | O(n²) PPR 計算、大規模グラフで非実用的 |
| ストレージ分散 | SQLite (89MB) + Vector files (3.7GB) | 管理複雑、バックアップ困難 |
| スケーラビリティ | 10万文書超で破綻 | ベクトルが RAM に収まらない |

### 1.3 解決方針

LadybugDB を単一の統合ストレージとして採用:
- **Cypher** クエリによるネイティブグラフ操作
- **HNSW ベクトルインデックス** による高速近似最近傍探索
- **BM25 全文検索** によるハイブリッド検索
- **PageRank アルゴリズム** によるネイティブグラフ分析
- 単一 `.lbug` ファイルへの統合（columnar disk storage）

### 1.4 スコープ

- **IN**: IGraphStore, IVectorIndex, IMemoryStore の LadybugDB 実装
- **IN**: マイグレーションスクリプト（既存 SQLite → LadybugDB）
- **IN**: ベンチマーク互換性維持（v0.1.0 同等精度）
- **OUT**: ドメイン層・アプリケーション層の変更
- **OUT**: MCP インターフェースの変更
- **OUT**: 新機能追加（検索アルゴリズム改善等）

---

## 2. 機能要件

### REQ-LDB-001: LadybugDB グラフストア

**種別**: UBIQUITOUS
**優先度**: P0

**要件**:
THE システム SHALL LadybugDB を使用してグラフノードおよびエッジを永続化し、IGraphStore インターフェースを完全に実装する。

**受入基準**:
- [ ] GraphNode の upsert/get/delete が Cypher クエリで実行される
- [ ] GraphEdge の upsert/get/delete が Cypher REL TABLE で実行される
- [ ] getAdjacent() が Cypher MATCH パターンで隣接ノードを取得する
- [ ] corpusId による分離が Node プロパティで実現される
- [ ] 既存の SQLiteGraphStore 全テストが LadybugDB 実装でもパスする

**トレーサビリティ**: DES-LDB-001
**パッケージ**: `memgraphrag`

---

### REQ-LDB-002: HNSW ベクトルインデックス

**種別**: UBIQUITOUS
**優先度**: P0

**要件**:
THE システム SHALL LadybugDB のネイティブ HNSW ベクトルインデックスを使用して IVectorIndex インターフェースを実装し、cosine 類似度による近似最近傍検索を提供する。

**受入基準**:
- [ ] FLOAT[1536] カラムに OpenAI text-embedding-3-small ベクトルを格納する
- [ ] HNSW インデックスが cosine metric で作成される
- [ ] upsert() が CREATE/MERGE Cypher で実行される
- [ ] search() が QUERY_VECTOR_INDEX で topK 件を返す
- [ ] 800K ベクトルに対する検索レイテンシが 100ms 以下である
- [ ] deleteByDocument() が corpusId + documentId フィルタで実行される

**トレーサビリティ**: DES-LDB-002
**パッケージ**: `memgraphrag`

---

### REQ-LDB-003: メモリストア統合

**種別**: UBIQUITOUS
**優先度**: P0

**要件**:
THE システム SHALL LadybugDB のノードテーブルを使用して Schema, Fact, Passage エンティティを永続化し、IMemoryStore インターフェースを実装する。

**受入基準**:
- [ ] Schema エンティティが Schema ノードテーブルに格納される
- [ ] Fact エンティティが Fact ノードテーブルに格納される
- [ ] Passage エンティティが Passage ノードテーブルに格納される
- [ ] MemorySnapshot の load/save が正しく動作する
- [ ] JobCheckpoint の保存・読み込みが正しく動作する
- [ ] validateIntegrity() がグラフ整合性チェックを実行する

**トレーサビリティ**: DES-LDB-003
**パッケージ**: `memgraphrag`

---

### REQ-LDB-004: グラフプロジェクション高速化

**種別**: EVENT-DRIVEN
**優先度**: P1

**要件**:
WHEN クエリ処理でグラフランキングが必要になった時、THE システム SHALL LadybugDB の Cypher クエリによる高速グラフプロジェクションを IGraphProjection として提供し、既存の SimplePPR（Personalized PageRank）にデータを供給する。

**補足**:
LadybugDB の PAGE_RANK はグローバル PageRank のみ対応し、Personalized（seed vector）をサポートしない。MemGraphRAG は query-specific な seed 重み付けが必須であるため、SimplePPR（JS in-memory）を維持し、LadybugDB はグラフデータソースとしてのみ使用する。

**受入基準**:
- [ ] LadybugGraphProjection が IGraphProjection を実装する
- [ ] getTransitions() が Cypher MATCH で corpus のエッジを返す
- [ ] getDanglingNodes() がリーフノードを Cypher で高速取得する
- [ ] 遷移行列のキャッシュにより 2回目以降の PPR が高速化される
- [ ] v0.1.0 と同等以上のベンチマーク精度を維持する

**トレーサビリティ**: DES-LDB-005
**パッケージ**: `memgraphrag`

---

### REQ-LDB-005: BM25 全文検索

**種別**: OPTIONAL
**優先度**: P2

**要件**:
WHERE ハイブリッド検索機能が有効な場合、THE システム SHALL LadybugDB の FTS 拡張による BM25 スコアリングを使用して、ベクトル検索結果をレキシカルマッチで補完する。

**受入基準**:
- [ ] Passage.text および Fact.head_entity/tail_entity に FTS インデックスが作成される
- [ ] QUERY_FTS_INDEX で BM25 スコア付きの検索結果が返される
- [ ] ベクトル検索結果と FTS 結果の融合（RRF or weighted）が可能である
- [ ] 既存の Bm25LexicalRetriever との互換性が維持される

**トレーサビリティ**: DES-LDB-005
**パッケージ**: `memgraphrag`

---

### REQ-LDB-006: データマイグレーション

**種別**: EVENT-DRIVEN
**優先度**: P0

**要件**:
WHEN ユーザーが既存 SQLite + Vector データベースからの移行を実行した時、THE システム SHALL 全データを LadybugDB 形式に変換し、データ損失なく移行を完了する。

**受入基準**:
- [ ] migrate コマンドが CLI で実行可能である
- [ ] SQLite の全 Schema/Fact/Passage レコードが LadybugDB に移行される
- [ ] FileVectorIndex の全ベクトルが FLOAT[1536] カラムに移行される
- [ ] GraphNode/GraphEdge が Cypher ノード/リレーションに変換される
- [ ] 移行後のデータ件数が元データと一致する（検証レポート出力）
- [ ] 移行処理が冪等である（再実行で重複しない）

**トレーサビリティ**: DES-LDB-006
**パッケージ**: `memgraphrag`
**CLI**: `npx memgraphrag migrate --from sqlite --to ladybug`

---

### REQ-LDB-007: インクリメンタルインデックス

**種別**: EVENT-DRIVEN
**優先度**: P1

**要件**:
WHEN 新規文書がインデックスされた時、THE システム SHALL 既存のグラフおよびベクトルインデックスを破壊せず、新規データのみを追加する。

**受入基準**:
- [ ] 既存ノード・エッジが保持されたまま新規ドキュメントが追加される
- [ ] HNSW インデックスが新規ベクトル挿入時に自動更新される
- [ ] FTS インデックスが新規テキスト挿入時に自動更新される
- [ ] JobCheckpoint による中断再開が正しく動作する
- [ ] 追加インデックスのパフォーマンスが線形スケールする

**トレーサビリティ**: DES-LDB-007
**パッケージ**: `memgraphrag`

---

### REQ-LDB-008: マルチホップグラフ探索

**種別**: EVENT-DRIVEN
**優先度**: P1

**要件**:
WHEN クエリ処理で関連エンティティの探索が必要になった時、THE システム SHALL Cypher の variable-length path を使用して、1〜3ホップの関連ノードを効率的に取得する。

**受入基準**:
- [ ] `MATCH (a)-[*1..3]->(b)` パターンで多段探索が実行される
- [ ] relation type によるフィルタリングが可能である
- [ ] weight によるパス選択（重み付き探索）が可能である
- [ ] acyclic セマンティクスで循環パスを排除する
- [ ] 20,000 ノードのグラフで 3ホップ探索が 500ms 以下で完了する

**トレーサビリティ**: DES-LDB-008
**パッケージ**: `memgraphrag`

---

## 3. 非機能要件

### REQ-LDB-NFR-001: パフォーマンス

**種別**: UBIQUITOUS
**優先度**: P0

**要件**:
THE システム SHALL 以下のパフォーマンス基準を満たす。

**受入基準**:
- [ ] ベクトル検索 (topK=10, 800K vectors): 100ms 以下
- [ ] グラフ隣接取得 (20K nodes): 10ms 以下
- [ ] PageRank (20K nodes, 28K edges): 1秒以下
- [ ] 全体クエリ応答時間: 15秒以下（LLM 応答含む）
- [ ] インデックス起動時間（DB オープン）: 3秒以下

---

### REQ-LDB-NFR-002: 精度維持

**種別**: UBIQUITOUS
**優先度**: P0

**要件**:
THE システム SHALL v0.1.0 のベンチマーク精度（HotpotQA 500q: 83.6%）を維持する。

**受入基準**:
- [ ] 同一 500 問ベンチマークで精度低下が 2pt 以内（≥ 81.6%）
- [ ] Bridge 問題の精度が 80% 以上を維持する
- [ ] Comparison 問題の精度が 88% 以上を維持する

---

### REQ-LDB-NFR-003: ストレージ効率

**種別**: UBIQUITOUS
**優先度**: P1

**要件**:
THE システム SHALL 現行の分散ストレージ（SQLite 89MB + Vectors 3.7GB）より管理容易な単一ファイル形式で保存する。

**受入基準**:
- [ ] 単一 `.lbug` ディレクトリにすべてのデータが格納される
- [ ] バックアップがディレクトリコピーのみで完結する
- [ ] ストレージサイズが現行比 150% 以内に収まる

---

### REQ-LDB-NFR-004: 後方互換性

**種別**: UBIQUITOUS
**優先度**: P0

**要件**:
THE システム SHALL ドメイン層インターフェース（IGraphStore, IVectorIndex, IMemoryStore）を変更せず、インフラストラクチャ層のみの置換で移行を完了する。

**受入基準**:
- [ ] `domain/storage/graphStore.ts` に変更がない
- [ ] アプリケーション層（QueryService, IndexingPipeline）に変更がない
- [ ] MCP サーバーインターフェースに変更がない
- [ ] 既存の 354 テストの 95% 以上がそのまま通過する

---

### REQ-LDB-NFR-005: スケーラビリティ

**種別**: STATE-DRIVEN
**優先度**: P1

**要件**:
WHILE コーパスが 10 万文書以上に成長した状態でも、THE システム SHALL クエリ応答時間 20 秒以内を維持する。

**受入基準**:
- [ ] HNSW インデックスが O(log n) の検索計算量を保証する
- [ ] PageRank が projected graph のサブセットに限定可能である
- [ ] メモリ使用量がコーパスサイズに対して線形スケールする（2倍のデータで 2倍以内のメモリ）

---

## 4. 制約

### 4.1 技術的制約

| 制約 | 詳細 |
|------|------|
| Node.js 20+ | ESM, TypeScript 5.3+ |
| LadybugDB | `@ladybugdb/core` v0.17+ |
| 単一ライター | 1プロセスのみ READ_WRITE アクセス |
| 固定次元ベクトル | FLOAT[1536]（text-embedding-3-small） |
| 拡張ロード | 接続ごとに LOAD vector/fts/algo が必要 |

### 4.2 運用制約

| 制約 | 詳細 |
|------|------|
| マイグレーション | 既存 v0.1.0 ユーザーへの移行パス提供必須 |
| 精度回帰 | 2pt 以上の低下は移行ブロッカー |
| テスト互換 | ドメイン/アプリ層テストは変更不可 |

---

## 5. LadybugDB スキーマ設計（概要）

```cypher
-- Node Tables
CREATE NODE TABLE SchemaEntity(
  schema_id STRING PRIMARY KEY,
  corpus_id STRING,
  head_type STRING,
  relation STRING,
  tail_type STRING,
  canonical_key STRING,
  frequency INT64,
  state STRING,
  version INT64,
  embedding FLOAT[1536]
);

CREATE NODE TABLE FactEntity(
  fact_id STRING PRIMARY KEY,
  corpus_id STRING,
  schema_id STRING,
  head_entity STRING,
  tail_entity STRING,
  confidence DOUBLE,
  document_id STRING,
  embedding FLOAT[1536]
);

CREATE NODE TABLE PassageEntity(
  passage_id STRING PRIMARY KEY,
  corpus_id STRING,
  document_id STRING,
  text STRING,
  embedding FLOAT[1536]
);

CREATE NODE TABLE GraphNodeEntity(
  node_id STRING PRIMARY KEY,
  corpus_id STRING,
  layer STRING,
  label STRING,
  ref_json STRING
);

-- Relationship Tables
CREATE REL TABLE GraphEdgeRel(
  FROM GraphNodeEntity TO GraphNodeEntity,
  edge_id STRING,
  corpus_id STRING,
  relation STRING,
  weight DOUBLE,
  bridge_kind STRING
);

CREATE REL TABLE FactEvidence(FROM FactEntity TO PassageEntity);
CREATE REL TABLE SchemaInstance(FROM FactEntity TO SchemaEntity);
```

---

## 6. 用語定義

| 用語 | 定義 |
|------|------|
| LadybugDB | 旧 Kuzu。組込型プロパティグラフ DB。Cypher + HNSW + FTS |
| HNSW | Hierarchical Navigable Small World。近似最近傍探索アルゴリズム |
| PPR | Personalized PageRank。テレポート確率付き PageRank |
| projected graph | algo 拡張用の仮想グラフ投影。接続単位でスコープ |
| corpus | ドキュメント集合の論理単位。corpusId で識別 |

---

## 7. 変更履歴

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-06-15 | GitHub Copilot | 初版作成 |
