# MemGraphRAG 要件定義書

**Document ID**: REQ-MEMGRAPHRAG-001
**Version**: 1.2
**Status**: Draft
**Created**: 2026-06-07
**Updated**: 2026-06-08
**Author**: GitHub Copilot (SDD Phase 1)

---

## 1. 概要

### 1.1 目的

本ドキュメントは、MemGraphRAG システムの機能要件・非機能要件を EARS 形式で定義する。
MemGraphRAG は、論文 "MemGraphRAG: Memory-based Multi-Agent System for Graph Retrieval-Augmented Generation" (KDD 2026) のアーキテクチャに基づき、**専門用語辞書**および**シソーラス辞書**を統合することで、従来の GraphRAG が持つ以下の3つの構造的欠陥を解決する高精度 GraphRAG システムである。

- **Thematic Irrelevance（主題的無関連性）**: 抽出されたトリプルがコーパスの主題と無関係
- **Logical Inconsistency（論理的不整合）**: 矛盾する事実が同一グラフ内に共存
- **Structural Fragmentation（構造的断片化）**: 孤立ノード・非連結コンポーネントがグラフの有用性を低下

### 1.2 システム構成

MemGraphRAG は **AIRA**（AI Research Administrator）のエコシステム内で MCP サーバーとして動作する。

```
┌──────────────────────────────────────────────────────────────────────┐
│                           AIRA (Host)                                │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────────┐    │
│  │ ToolUniverse │    │   markitdown │    │   MemGraphRAG        │    │
│  │   MCP Server │    │  (PDF → MD)  │    │   MCP Server         │    │
│  │              │    │              │    │                      │    │
│  │ PubMed       │    │ PDF → MD     │    │ ┌──────────────────┐ │    │
│  │ arXiv        │───▶│ PPTX → MD    │───▶│ │ Global Memory    │ │    │
│  │ ChEMBL       │    │ DOCX → MD    │    │ │  Ontology Layer  │ │    │
│  │ Semantic     │    │ HTML → MD    │    │ │  Fact Layer      │ │    │
│  │ Scholar      │    │              │    │ │  Passage Layer   │ │    │
│  │ ... (89 DBs) │    └──────────────┘    │ ├──────────────────┤ │    │
│  └──────────────┘                        │ │ Multi-Agent      │ │    │
│                                          │ │  Extraction      │ │    │
│                                          │ │  Conflict Detect │ │    │
│                                          │ │  Conflict Resolve│ │    │
│                                          │ ├──────────────────┤ │    │
│                                          │ │ Dictionary &     │ │    │
│                                          │ │ Thesaurus Engine │ │    │
│                                          │ └──────────────────┘ │    │
│                                          └──────────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
```

**データフロー:**

```
1. AIRA ユーザーが研究テーマを指定
2. ToolUniverse MCP 経由で論文を検索・取得（PubMed, arXiv, Semantic Scholar 等）
3. markitdown で PDF → Markdown に変換
4. AIRA が MCP 経由で MemGraphRAG の index ツールを呼び出し
5. MemGraphRAG がマルチエージェントで知識グラフを構築
6. AIRA が MCP 経由で MemGraphRAG の query ツールを呼び出し
7. MemGraphRAG が階層的検索で関連知識を返却
```

### 1.3 スコープ

| 対象 | 説明 |
|------|------|
| **MCP サーバー** | AIRA から呼び出し可能な MCP ツールとしてのインターフェース |
| **ドキュメント取り込み** | markitdown 変換済み Markdown テキストの受け入れ |
| **グラフ構築** | メモリベース・マルチエージェントによるナレッジグラフ構築 |
| **辞書統合** | 専門用語辞書・シソーラス辞書によるNLP抽出精度の向上 |
| **階層的検索** | メモリガイド型階層的リトリーバルアルゴリズム |
| **日英対応** | バイリンガル（日本語・英語）テキスト処理 |

**スコープ外:**
- AIRA 本体の修正（AIRA は MCP クライアントとして既存機能を使用）
- ToolUniverse MCP の修正（既存の論文検索・取得機能をそのまま使用）
- markitdown 本体の修正（Python ライブラリとしてそのまま使用）

### 1.4 参照文献

| 参照 | 説明 |
|------|------|
| `references/2606.00610v1.pdf` | MemGraphRAG 原論文 (KDD 2026) |
| https://github.com/nahisaho/aira | AIRA - AI Research Administrator (v3.2.1) |
| https://github.com/microsoft/markitdown | markitdown - PDF/ドキュメント → Markdown 変換 |
| Qiita #10 | scispaCy による Lazy GraphRAG NLP最適化 |
| Qiita #11 | Semantic Scholar API ドメイン辞書統合 |
| `references/altanative-lazygraphrag/` | LazyGraphRAG 実装知見 |

### 1.5 用語定義

| 用語 | 定義 |
|------|------|
| **AIRA** | AI Research Administrator。Web ベースの研究支援プラットフォーム |
| **ToolUniverse** | 89の科学データベースにアクセスする MCP サーバー |
| **markitdown** | Microsoft 製の PDF/ドキュメント → Markdown 変換ライブラリ (Python) |
| **MCP** | Model Context Protocol。AI エージェントがツールを呼び出すための標準プロトコル |
| **Schema** | 型レベルの関係制約 s = (t_h, r, t_t)。例: (Person, born_in, Country) |
| **Fact** | Schema のインスタンス f = (e_h, r, e_t)。例: (Einstein, born_in, Germany) |
| **Passage** | 事実の根拠となるテキスト断片 p ∈ P |
| **Ontology** | 有効な Schema の集合体 O = {s_1, ..., s_n} |
| **Type** | 高レベルの分類カテゴリ t ∈ T（例: Person）。φ(e) = t でエンティティと紐付く |
| **Entity** | テキストに根拠を持つ具象インスタンス e ∈ E（例: Einstein） |
| **専門用語辞書** | ドメイン固有の用語リスト（Semantic Scholar API 等から構築） |
| **シソーラス辞書** | 同義語・上位語・下位語の関係を定義した辞書 |
| **PPR** | Personalized PageRank。v^(k+1) = (1-λ)·W·v^(k) + λ·v^(0) |
| **Hub Suppression** | 高次数ノードの伝播影響を抑制する 1/log(deg(t)+2) 正則化 |
| **Information Density** | IDF ベースのパッセージ情報量スコア |

### 1.6 論文アルゴリズム参照マッピング

本要件は論文 Algorithm 1（Memory-based Indexing Graph Construction）の4ステージ構造に対応する。

| Algorithm 1 Stage | 対応要件 | 説明 |
|-------------------|----------|------|
| **Stage I**: Composite Extraction | REQ-MG-010 | A_ext(c_i) → {O_cand, T_cand, P_src} |
| **Stage II**: Schema Filtering + Triple Activation | REQ-MG-013, REQ-MG-001 | Freq(o) ≥ τ → Stable → Active |
| **Stage III**: Conflict Detection + Adjudication | REQ-MG-011, REQ-MG-012 | Sim > δ ∨ Match → C_ctx → A_res |
| **Stage IV**: Graph Projection + Bridging | REQ-MG-014, REQ-MG-015 | G_ont + G_fac + G_pas + bridging edges |
| **Retrieval**: Memory Filtering | REQ-MG-040 | 三層並列 Top-K |
| **Retrieval**: Node Initialization | REQ-MG-041 | 式6(Entity), 式7(Type+Hub), 式8(Passage+IDF) |
| **Retrieval**: PPR Propagation | REQ-MG-042 | v^(k+1) = (1-λ)Wv^(k) + λv^(0), λ=0.5 |

### 1.7 論文パラメータ一覧

| パラメータ | 記号 | 論文デフォルト | 本実装デフォルト | 説明 |
|-----------|------|---------------|----------------|------|
| Schema 安定化閾値 | τ | 未公開 | 2 | Freq(s) ≥ τ で Stable 昇格 |
| 衝突検出類似度閾値 | δ | 未公開 | 0.8 | Sim(t_new, t') > δ で衝突候補 |
| ブリッジング類似度閾値 | δ_b | 未公開 | 0.7 | Sim(e_i, e_j) > δ_b でブリッジ |
| PPR テレポート確率 | λ | 0.5 | 0.5 | ローカル近傍重視 |
| パッセージダンピング | α | 0.05 | 0.05 | パッセージノード初期化の抑制 |
| トップK（検索） | K | 未公開 | 10 | 各層からの候補数 |
| トップM（エンティティ出力数） | M | 未公開 | 5 | PPR 後のエンティティ選択数。MCP `query.top_m` に対応 |
| 検索類似度閾値 | τ_r | 未公開 | 0.5 | メモリフィルタリングの足切り閾値。MCP `query.threshold` に対応。Schema 安定化閾値 τ とは別パラメータ |
| PPR 収束閾値 | ε | 未公開 | 1e-6 | PPR 反復の収束判定 |
| PPR 最大反復数 | — | 未公開 | 50 | PPR 反復上限 |
| 衝突スキャン候補上限 | L_conf | — | 100 | ベクトルインデックスからの候補取得上限（O(N)スキャン防止） |
| ブリッジ候補上限 | L_bridge | — | 50 | エンティティごとのブリッジ候補上限 |
| 埋め込みモデル | — | NV-Embed-v2 | 設定可能 | エンベディングプロバイダー |
| LLM モデル | — | GPT-4o-mini | 設定可能 | 抽出・生成用 |

---

## 2. 機能要件

### 2.1 三層グローバルメモリ (REQ-MG-001 〜 REQ-MG-006)

#### REQ-MG-001: Ontology Layer（オントロジー層）
**パターン**: UBIQUITOUS

```
THE MemGraphRAG システム SHALL
Schema（型レベル関係制約）を抽出頻度と共に Ontology Layer に保存し、
頻度ベースの安定化フィルタにより信頼度の高い Schema のみを
「Stable Schema」として活性化する。
```

**受入基準**:
- [ ] Schema が s = (t_h, r, t_t) の三つ組として保存される（t_h, t_t ∈ T: 型集合, r: 意味的関係）
- [ ] 各 Schema の抽出頻度 Freq(s) が記録される
- [ ] Schema の状態遷移: State(o) = Stable if Freq(o) ≥ τ, Pending otherwise（論文式14）
- [ ] 頻度閾値 τ が設定可能（デフォルト: 2）
- [ ] Stable Schema のみが Fact の活性化に使用される（カスケード活性化）
- [ ] 型 t ∈ T は高レベルの分類カテゴリ（例: Person）、エンティティ e ∈ E はその具象インスタンス（例: Einstein）であり、φ(e) = t でマッピングされる

#### REQ-MG-002: Fact Layer（事実層）
**パターン**: UBIQUITOUS

```
THE MemGraphRAG システム SHALL
具体的なエンティティ間の関係（Fact）を Fact Layer に保存し、
各 Fact を対応する Schema および根拠 Passage と双方向にリンクする。
```

**受入基準**:
- [ ] Fact が f = (e_h, r, e_t) の三つ組として保存される（e_h, e_t ∈ E: エンティティ集合）
- [ ] 各 Fact f が Schema s = (φ(e_h), r, φ(e_t)) に厳密にアライメントされる
- [ ] 各 Fact が少なくとも1つの Passage にリンクされる: |E(t)| ≥ 1（論文式12）
- [ ] Active/Inactive ステータス: Schema が Stable の Fact のみが Active に遷移
- [ ] Inactive Fact はグラフ構築・検索に使用されないが、メモリには保持される

#### REQ-MG-003: Passage Layer（パッセージ層）
**パターン**: UBIQUITOUS

```
THE MemGraphRAG システム SHALL
元テキストの断片を Passage Layer に保存し、
各 Passage を抽出された Fact へのエビデンスグラウンディングとして紐付ける。
```

**受入基準**:
- [ ] Passage p ∈ P がコーパスのテキスト断片としてメタデータと共に保存される
- [ ] Passage と Fact の双方向リンクが維持される（Ψ ⊆ M_fac × M_pas, 論文式11）
- [ ] ソースドキュメント情報（タイトル、セクション、チャンクID、位置情報）が保持される
- [ ] 各 Fact のエビデンスセット E(t) = { p ∈ M_pas | (t, p) ∈ Ψ } が取得可能

#### REQ-MG-004: メモリ間の密インデキシング
**パターン**: UBIQUITOUS

```
THE MemGraphRAG システム SHALL
三層メモリ間の双方向インタラクションとして、
Schema-Instance アライメント（Ontology ↔ Fact）と
Fact-Evidence グラウンディング（Fact ↔ Passage）を維持する。
```

**受入基準**:
- [ ] **Schema-Instance アライメント（Φ）**: ボトムアップ: Φ: M_fac → M_ont で各 Fact を Schema に割当（論文式9）; トップダウン: T(s) = { t ∈ M_fac | Φ(t) = s } でインスタンス集合を取得（論文式10）
- [ ] **Fact-Evidence グラウンディング（Ψ）**: Ψ ⊆ M_fac × M_pas で双方向リンク。E(t) = { p ∈ M_pas | (t, p) ∈ Ψ }, |E(t)| ≥ 1（論文式11-12）
- [ ] Schema から該当する全 Fact を検索可能（T(s)）
- [ ] Fact から根拠 Passage を検索可能（E(t)）
- [ ] Passage から抽出された全 Fact を検索可能（逆引き）
- [ ] インデックスの整合性が常に保持される（Schema 削除時のカスケード等）

#### REQ-MG-005: メモリのスナップショット・データ交換
**パターン**: EVENT-DRIVEN

```
WHEN メモリのスナップショット出力が要求された時、
THE MemGraphRAG システム SHALL
三層グローバルメモリの全データを JSON 形式でシリアライズし、
データ交換・バックアップ・デバッグ用にエクスポートする。
```

**受入基準**:
- [ ] 三層全てが単一または複数の JSON ファイルにエクスポートされる
- [ ] JSON からのインポートにより等価なメモリ状態が復元される
- [ ] **注**: 権威的永続化は SQLite（REQ-MG-NF-008）が担当。JSON は永続化レイヤーではなく、データ交換・移行・デバッグ用途
- [ ] MCP `export_graph` ツール（REQ-MG-078）と連携

#### REQ-MG-006: メモリ統計情報
**パターン**: EVENT-DRIVEN

```
WHEN メモリ統計が要求された時、
THE MemGraphRAG システム SHALL
各層のエントリ数、リンク数、Stable Schema 数、Active Fact 数、
Conflict 検出数を含む統計レポートを生成する。
```

**受入基準**:
- [ ] Ontology Layer: 総Schema数、Stable Schema数、頻度分布
- [ ] Fact Layer: 総Fact数、Active Fact数、Inactive Fact数
- [ ] Passage Layer: 総Passage数、リンク済み Fact 数
- [ ] 全体: 衝突検出数、解決済み衝突数

---

### 2.2 マルチエージェントグラフ構築 (REQ-MG-010 〜 REQ-MG-018)

#### REQ-MG-010: 抽出エージェント（Extraction Agent）
**パターン**: EVENT-DRIVEN

```
WHEN ドキュメントチャンクが入力された時、
THE MemGraphRAG システム SHALL
抽出エージェントにより、候補 Schema、インスタンス化された Fact、
根拠 Passage を同時に生成し、三層メモリに格納する。
```

**受入基準**:
- [ ] 単一チャンク c_i から Composite Extraction Record が生成される: A_ext(c_i) → {O_cand, T_cand, P_src}（論文式13, Algorithm 1 Stage I）
- [ ] O_cand: 候補 Schema、T_cand: 候補 Fact、P_src: ソースパッセージが同時抽出される
- [ ] 抽出された Fact が対応する Schema に厳密にアライメントされる
- [ ] 各 Fact が根拠 Passage にグラウンディングされる
- [ ] 新規 Schema は候補（Pending）として M_ont に登録される（Probationary Extraction Protocol）
- [ ] Pending Schema はグラフ構造 G に反映されない（サンドボックス分離）

#### REQ-MG-010b: Schema 正規化（Schema Canonicalization）
**パターン**: EVENT-DRIVEN
**優先度**: Must | **パッケージ**: `memgraphrag`

```
WHEN 候補 Schema O_cand が抽出された時、
THE MemGraphRAG システム SHALL
型ラベルおよび関係述語を正規化し、
意味的に等価な Schema を統一してから Freq(s) をインクリメントする。
```

**受入基準**:
- [ ] 型ラベルの正規化: 大文字/小文字統一、単数/複数統一、シソーラス辞書による同義語マッピング（例: "Method"/"Technique"/"Approach" → "Method"）
- [ ] 関係述語の正規化: 動詞の基本形変換、同義述語の統一（例: "improves"/"enhances"/"increases" → "improves"）
- [ ] 日英対応: バイリンガルの場合、英語正規化形を正準形とし、日本語形をエイリアスとして保持
- [ ] エンベディング類似度による統一: Sim(s1, s2) > δ_schema の場合にマージ候補として提示（δ_schema は設定可能、デフォルト: 0.9）
- [ ] 正規化前のオリジナル表記がエイリアスとして保持される
- [ ] 正規化の確信度が低い場合（類似度 < δ_schema）は別 Schema として保持し、マージは行わない

**トレーサビリティ**: DES-MG-010b

#### REQ-MG-011: 衝突検出エージェント（Conflict Detection Agent）
**パターン**: EVENT-DRIVEN
**優先度**: Must | **パッケージ**: `memgraphrag`

```
WHEN 新しいトリプルが Fact Layer で活性化された時、
THE MemGraphRAG システム SHALL
衝突検出エージェントにより、既存 Fact との意味的類似度および
オントロジーレベルの構造制約に基づき、衝突セットを識別する。
```

**受入基準**:
- [ ] **相互排他的衝突（Mutually Exclusive）**: 同一機能属性に異なる値が割り当てられた場合（例: Newton born_in 1643 vs 1645）
- [ ] **時間的衝突（Temporal Conflict）**: 時間依存の事実が時間メタデータなしに混在する場合（例: Biden President USA vs Trump President USA）
- [ ] **粒度衝突（Granularity Conflict）**: 同一事実が異なる抽象レベルで記述された場合（例: born_in Shanghai vs born_in China）
- [ ] 衝突検出は Active 状態に遷移した Fact に対してのみトリガーされる（Algorithm 1 Stage III）
- [ ] ハイブリッドスキャン（Active Fact のみ対象）: T_conf = { t' ∈ M_fac_active | t' ≠ t_new ∧ same_corpus(t', t_new) ∧ (Sim(t_new, t') > δ ∨ Match(t_new, t')) }（論文式15 改）
- [ ] スキャン効率化: ベクトルインデックスから上位 L_conf 件（デフォルト: 100）を候補取得後、δ 閾値でフィルタリング（O(N) 全件スキャン防止）
- [ ] 意味的類似度閾値 δ が設定可能（デフォルト: 0.8）
- [ ] シンボリックマッチング Match() が主語・述語の一致を判定する
- [ ] 衝突セットが (new_triple, conflicting_triples[], conflict_type) として返される

#### REQ-MG-012: 衝突解決エージェント（Conflict Resolution Agent）
**パターン**: EVENT-DRIVEN
**優先度**: Must | **パッケージ**: `memgraphrag`

```
WHEN 衝突セットが検出された時、
THE MemGraphRAG システム SHALL
衝突解決エージェントにより、Schema 制約（Ontology Layer）と
根拠テキスト（Passage Layer）を参照して衝突を解決する。
```

**受入基準**:
- [ ] エビデンスコンテキスト構築: C_ctx = Ψ(t_new) ∪ ⋃_{t' ∈ T_conf} Ψ(t')（論文式16）
- [ ] A_res が C_ctx に基づきエビデンス駆動の判定を実行する（「判事がケースファイルを審理する」パターン）
- [ ] 解決結果は以下の状態のいずれかを持つ:
  - `resolved_keep_new`: 新 Fact を採用、旧 Fact を Inactive 化
  - `resolved_keep_existing`: 旧 Fact を維持、新 Fact を Inactive 化
  - `merged`: 冗長トリプルを統合
  - `temporalized`: 時間修飾子を付加して共存
  - `granularity_linked`: 粒度関係（IS-A/PART-OF）として両方を保持
  - `unresolved`: エビデンス不十分で自動解決不可（要手動レビュー）
- [ ] 各解決結果に confidence スコア（0-1）が付与される
- [ ] `unresolved` 状態の衝突は analyze_conflicts（REQ-MG-077）で一覧取得可能
- [ ] 解決根拠（エビデンス）が記録される（どの Passage がどの判定を支持したか）

#### REQ-MG-013: 主題的ノイズ除去（Thematic Denoising）
**パターン**: UBIQUITOUS

```
THE MemGraphRAG システム SHALL
統一スキーマフィルタリングにより、コーパスの主題と無関連な
トリプルを除外し、主題的に一貫したグラフを構築する。
```

**受入基準**:
- [ ] 低頻度 Schema に属する Fact が Inactive 化される
- [ ] 頻度閾値 τ が設定可能（デフォルト: 2）
- [ ] Confidence-Driven State Promotion: State(o) = Stable if Freq(o) ≥ τ（論文式14）
- [ ] Stable 昇格時にカスケード活性化: 該当 Schema に紐づく Fact が Active に遷移
- [ ] Active Fact のみが衝突検出フェーズに進む
- [ ] フィルタリング前後のグラフ品質メトリクスが取得可能
- [ ] *参考*: アブレーション実験で Schema Filter 除去で HotpotQA -2.45%（69.40%→66.95%相当の劣化, 論文 §5.5）。本実装の受入基準ではない

#### REQ-MG-014: 構造的統合（Structural Unification）
**パターン**: UBIQUITOUS

```
THE MemGraphRAG システム SHALL
メモリガイド型ブリッジングにより、孤立サブグラフ間に
型ベース接続（共有 Schema）および類似度ベース接続（エンティティ埋め込み類似度）の
ブリッジングエッジを追加し、グラフの連結性を向上させる。
```

**受入基準**:
- [ ] **型ベース接続**: 共有 Stable Schema に基づくブリッジングエッジ生成（Algorithm 1 Step 29）
- [ ] **類似度ベース接続**: エンティティ埋め込み類似度 > δ_b のペアにブリッジングエッジ生成（Algorithm 1 Step 30）
- [ ] ブリッジング閾値 δ_b が設定可能（δ とは別パラメータ）。候補取得上限 L_bridge（デフォルト: 50）でエンティティごとの計算量を制限
- [ ] 連結コンポーネント数の削減が測定可能
- [ ] ブリッジングエッジに根拠メタデータ（type_based / similarity_based + score）が付与される
- [ ] *参考*: 論文のグラフ品質指標: 平均次数 8.92〜14.37、クラスタリング係数 0.527〜0.865（Table 5）。本実装の受入基準ではない

#### REQ-MG-015: 階層的インデキシンググラフ構築
**パターン**: EVENT-DRIVEN

```
WHEN グラフ構築が完了した時、
THE MemGraphRAG システム SHALL
三層メモリから以下の3つの相互接続されたグラフビューを構築する：
(i) Semantic Ontology Graph (G_ont)
(ii) Fact Graph (G_fac)
(iii) Source Evidence Graph (G_pas)
```

**受入基準**:
- [ ] G_ont（Semantic Ontology Graph）: Stable Schema の型関係ネットワーク。ドメインの論理的骨格として機能
- [ ] G_fac（Fact Graph）: Active Fact のエンティティ関係グラフ。マルチホップ推論の基盤
- [ ] G_pas（Source Evidence Graph）: G_fac のエンティティ・関係をソーステキストにグラウンディング
- [ ] 3グラフ間のクロスリファレンスが維持される（G_ont → G_fac → G_pas の階層ナビゲーション）
- [ ] 全グラフがマージされて統合階層グラフ G を構成（Algorithm 1 Step 31）

#### REQ-MG-016: インクリメンタルグラフ更新
**パターン**: EVENT-DRIVEN

```
WHEN 新規ドキュメントが追加された時、
THE MemGraphRAG システム SHALL
既存のグローバルメモリと階層グラフを破壊することなく、
新規情報をインクリメンタルに統合する。
```

**受入基準**:
- [ ] 既存のグラフが保持される
- [ ] 新規エンティティ・関係が追加される
- [ ] 既存エンティティとの衝突が検出・解決される
- [ ] 処理時間がコーパス全体の再構築より大幅に短い

#### REQ-MG-017: バッチ処理
**パターン**: EVENT-DRIVEN

```
WHEN 複数ドキュメントのバッチ処理が要求された時、
THE MemGraphRAG システム SHALL
ドキュメントを順次処理し、各チャンクの抽出結果を
グローバルメモリに蓄積しながらグラフを進化させる。
```

**受入基準**:
- [ ] 複数ドキュメントが順次処理される
- [ ] 処理進捗が報告される
- [ ] 中断・再開が可能
- [ ] メモリ使用量が線形スケーリング以下

#### REQ-MG-018: LLM プロバイダー抽象化
**パターン**: UBIQUITOUS

```
THE MemGraphRAG システム SHALL
LLM 呼び出しを抽象インターフェースで定義し、
OpenAI, Azure OpenAI, Ollama 等の複数プロバイダーに対応する。
```

**受入基準**:
- [ ] ILLMProvider インターフェースが定義される
- [ ] OpenAI / Azure OpenAI アダプターが提供される
- [ ] モデル名、温度、最大トークン数が設定可能
- [ ] レート制限・リトライが組み込まれる

---

### 2.3 専門用語辞書統合 (REQ-MG-020 〜 REQ-MG-026)

#### REQ-MG-020: 専門用語辞書のデータモデル
**パターン**: UBIQUITOUS

```
THE MemGraphRAG システム SHALL
専門用語辞書を以下の構造で管理する：
- 用語テキスト
- ドメインカテゴリ
- 出現頻度 / 信頼度スコア
- ソース情報（API, 手動, 抽出等）
```

**受入基準**:
- [ ] 用語エントリが上記フィールドを持つ
- [ ] JSON 形式での入出力が可能
- [ ] 辞書のバージョン管理が可能
- [ ] 複数ドメインの用語を統合管理可能

#### REQ-MG-021: Semantic Scholar API 連携
**パターン**: OPTIONAL

```
WHERE Semantic Scholar API 連携機能が有効な場合、
THE MemGraphRAG システム SHALL
指定したドメインの学術論文から専門用語を自動収集し、
ドメイン辞書を構築・更新する。
```

**受入基準**:
- [ ] 検索クエリに基づく論文の取得が可能
- [ ] タイトル・アブストラクトからの用語抽出が実行される
- [ ] 頻度ベースのフィルタリングが適用される
- [ ] レート制限対応（指数バックオフ）が実装される
- [ ] レスポンスキャッシュ（24時間 TTL）が実装される

#### REQ-MG-022: 辞書ブースト付きエンティティ抽出
**パターン**: EVENT-DRIVEN

```
WHEN テキストからエンティティが抽出された時、
THE MemGraphRAG システム SHALL
専門用語辞書とのマッチングを実行し、辞書に存在する用語の
重要度スコアをブーストファクター（デフォルト: 2.0）で増幅する。
```

**受入基準**:
- [ ] NLP 抽出後に辞書マッチングが実行される
- [ ] 辞書内用語のスコアがブーストされる
- [ ] NLP が見逃した複合名詞が辞書マッチングで補完される
- [ ] ブーストファクターが設定可能

#### REQ-MG-023: カスタム辞書の登録
**パターン**: EVENT-DRIVEN

```
WHEN ユーザーがカスタム辞書ファイルを指定した時、
THE MemGraphRAG システム SHALL
JSON 形式の辞書ファイルを読み込み、既存辞書とマージする。
```

**受入基準**:
- [ ] JSON ファイルからの辞書読み込みが可能
- [ ] 既存辞書との重複除去マージが実行される
- [ ] ドメインカテゴリごとの管理が可能

#### REQ-MG-024: 辞書エントリの自動学習
**パターン**: EVENT-DRIVEN

```
WHEN グラフ構築中に高頻度で出現するエンティティが検出された時、
THE MemGraphRAG システム SHALL
当該エンティティを辞書候補として提案し、
承認後に辞書に自動登録する。
```

**受入基準**:
- [ ] 高頻度エンティティの自動検出が実行される
- [ ] 候補リストがユーザーに提示される
- [ ] 承認済み候補が辞書に追加される
- [ ] 頻度閾値が設定可能

#### REQ-MG-025: 辞書の統計・分析
**パターン**: EVENT-DRIVEN

```
WHEN 辞書分析が要求された時、
THE MemGraphRAG システム SHALL
辞書の総用語数、ドメイン別分布、カバレッジ率、
グラフ構築への貢献度（ブースト適用率、新規発見用語数）を報告する。
```

**受入基準**:
- [ ] 統計レポートが生成される
- [ ] グラフ構築との連携メトリクスが含まれる

#### REQ-MG-026: 辞書のエクスポート
**パターン**: EVENT-DRIVEN

```
WHEN 辞書エクスポートが要求された時、
THE MemGraphRAG システム SHALL
辞書データを JSON 形式でエクスポートする。
バージョン、ドメイン一覧、用語数、生成日時をメタデータとして含む。
```

**受入基準**:
- [ ] JSON 形式でのエクスポートが可能
- [ ] メタデータが含まれる

---

### 2.4 シソーラス辞書統合 (REQ-MG-030 〜 REQ-MG-036)

#### REQ-MG-030: シソーラス辞書のデータモデル
**パターン**: UBIQUITOUS

```
THE MemGraphRAG システム SHALL
シソーラス辞書を以下の意味関係で管理する：
- 同義語（synonym）: 同じ概念を表す異なる表現
- 上位語（hypernym）: より広い概念
- 下位語（hyponym）: より狭い概念
- 関連語（related）: 意味的に関連する語
```

**受入基準**:
- [ ] 4種類の意味関係が表現可能
- [ ] 双方向の参照が可能（A の同義語 B → B の同義語 A）
- [ ] 階層構造（上位語→下位語）のトラバースが可能
- [ ] JSON 形式での入出力が可能

#### REQ-MG-031: 同義語によるエンティティ正規化
**パターン**: EVENT-DRIVEN

```
WHEN エンティティが抽出された時、
THE MemGraphRAG システム SHALL
シソーラス辞書の同義語情報を参照し、
表記揺れを統一した正規化形にマッピングする。
```

**受入基準**:
- [ ] "ML" → "machine learning" 等の略語正規化が実行される
- [ ] "深層学習" → "deep learning" 等の多言語正規化が実行される
- [ ] 正規化前の元表記が保持される
- [ ] 正規化ルールの優先順位が設定可能

#### REQ-MG-032: 上位語/下位語によるグラフ拡張
**パターン**: OPTIONAL

```
WHERE シソーラスベースのグラフ拡張機能が有効な場合、
THE MemGraphRAG システム SHALL
抽出されたエンティティの上位語・下位語関係をシソーラスから取得し、
階層的な IS-A 関係としてグラフに追加する。
```

**受入基準**:
- [ ] エンティティ → 上位語の IS-A エッジが追加される
- [ ] 上位語の再帰的展開が設定可能（最大深度指定）
- [ ] 追加されたエッジにソース（thesaurus）が記録される

#### REQ-MG-033: シソーラスによる衝突検出精度向上
**パターン**: EVENT-DRIVEN

```
WHEN 衝突検出エージェントが Fact 間の類似度を計算する時、
THE MemGraphRAG システム SHALL
シソーラスの同義語・関連語情報を活用して、
テキスト表現が異なるが意味的に同一・類似の Fact を正確に識別する。
```

**受入基準**:
- [ ] 同義語ペアのエンティティを含む Fact が衝突候補として検出される
- [ ] 類似度計算にシソーラス距離が考慮される
- [ ] False negative（見逃し）の削減が測定可能

#### REQ-MG-034: シソーラスによるクエリ拡張
**パターン**: EVENT-DRIVEN

```
WHEN ユーザークエリが入力された時、
THE MemGraphRAG システム SHALL
シソーラスの同義語・関連語を用いてクエリを拡張し、
検索のリコールを向上させる。
```

**受入基準**:
- [ ] クエリ内の用語に対して同義語が追加される
- [ ] 拡張度合い（追加語数）が設定可能
- [ ] 拡張により検索リコールが向上する
- [ ] 元のクエリの意図が保持される

#### REQ-MG-035: カスタムシソーラスの登録
**パターン**: EVENT-DRIVEN

```
WHEN ユーザーがカスタムシソーラスファイルを指定した時、
THE MemGraphRAG システム SHALL
JSON 形式のシソーラスファイルを読み込み、既存シソーラスとマージする。
```

**受入基準**:
- [ ] JSON ファイルからのシソーラス読み込みが可能
- [ ] 既存シソーラスとの非破壊マージが実行される
- [ ] 循環参照がバリデーションされる

#### REQ-MG-036: シソーラスエントリの自動推定
**パターン**: EVENT-DRIVEN

```
WHEN グラフ構築中にエンティティ間の高い類似度が検出された時、
THE MemGraphRAG システム SHALL
当該エンティティペアを同義語候補としてシソーラスに提案する。
```

**受入基準**:
- [ ] 埋め込み類似度に基づく同義語候補の検出が実行される
- [ ] 候補リストがユーザーに提示される
- [ ] 承認済み候補がシソーラスに追加される

---

### 2.5 メモリガイド型階層的検索 (REQ-MG-040 〜 REQ-MG-046)

#### REQ-MG-040: 多層メモリフィルタリング
**パターン**: EVENT-DRIVEN

```
WHEN ユーザークエリが入力された時、
THE MemGraphRAG システム SHALL
三層グローバルメモリ（Ontology, Fact, Passage）から
並列にトップK候補を検索し、検索類似度閾値 τ_r で
フィルタリングして高信頼候補のみを保持する。
```

**受入基準**:
- [ ] 三層からの並列検索が実行される（M_ont, M_fac, M_pas から同時にトップK取得）
- [ ] 検索類似度閾値 τ_r が設定可能（デフォルト: 0.5）。Schema 安定化閾値 τ とは別パラメータ。MCP `query.threshold` に対応
- [ ] 構造候補が空の場合、Passage ベースのフォールバックが実行される
- [ ] トップK の K が設定可能（デフォルト: 10）。MCP `query.top_k` に対応
- [ ] 各層からの候補に対して Sim(q, candidate) > τ_r でフィルタリング

#### REQ-MG-041: 構造認識型ノード初期化
**パターン**: EVENT-DRIVEN

```
WHEN メモリフィルタリングが完了した時、
THE MemGraphRAG システム SHALL
検索されたエビデンスを階層グラフに射影し、
エンティティノード（Fact ベース）、型ノード（Schema ベース）、
パッセージノード（Passage ベース）の初期リセット確率分布を算出する。
```

**受入基準**:
- [ ] **エンティティノード初期化**: P_init(e) = mean_{f ∈ Facts(e)} Sim(q, f)（論文式6）— 関連 Fact の類似度平均。Facts(e) が空の場合 P_init(e) = 0
- [ ] **型ノード初期化（Hub Suppression）**: P_init(t) = SchemaRelevance(t) × 1/log(deg(t) + 2)（論文式7 改）— +2 で deg=0 時の除零を回避。SchemaRelevance(t) = max_{s ∈ Schemas(t)} Sim(q, s) で定義
- [ ] **パッセージノード初期化（Information Density Term）**: P_init(p) = Sim(q, p) × α × σ(IDF_density(p))（論文式8）— α=0.05 のダンピング。σ はシグモイド関数 σ(x) = 1/(1+exp(-x))。IDF_density(p) = mean_{e ∈ Entities(p)} log(|D|/df(e)) で定義（|D|: 総パッセージ数、df(e): エンティティ e を含むパッセージ数）
- [ ] 全ノードの初期化スコアが 0 の場合、Passage ベースフォールバック（REQ-MG-044）にフォールバック
- [ ] 初期化分布 v^(0) が L1 正規化される（各ノードタイプ内で合計=1）
- [ ] *参考*: アブレーション実験で Hub Suppression 除去で -2.18%、Information Density Term 除去で -0.73%（HotpotQA, 論文 §5.5）

#### REQ-MG-042: Personalized PageRank によるグラフ伝播
**パターン**: EVENT-DRIVEN

```
WHEN ノード初期化が完了した時、
THE MemGraphRAG システム SHALL
異種グラフ上で Personalized PageRank を実行し、
グローバルに重要なノードとパッセージをランキングする。
```

**受入基準**:
- [ ] PPR 更新式: v^(k+1) = (1-λ)·W·v^(k) + λ·v^(0)（論文 §4.3）
- [ ] **遷移行列 W**: 行正規化（row-stochastic）。W_ij = w_ij / Σ_k w_ik。エッジ重みは型別: Schema-Fact 間=1.0, Fact-Passage 間=1.0, ブリッジングエッジ=Sim スコア。ダングリングノード（出辺なし）はテレポートベクトル v^(0) に均一遷移
- [ ] テレポート確率 λ が設定可能（デフォルト: 0.5 — 論文推奨値。ローカル近傍に伝播を制限する設計意図）
- [ ] **注**: 一般的な PPR のダンピングファクター α=0.85 とは異なり、論文は λ=0.5 でローカル近傍重視
- [ ] 収束閾値 ε が設定可能（デフォルト: 1e-6）。||v^(k+1) - v^(k)||_1 < ε で収束判定
- [ ] 最大反復回数が設定可能（デフォルト: 50）
- [ ] トップK パッセージ + トップM エンティティを選択して結果を返す。M が設定可能（デフォルト: 5）。MCP `query.top_m` に対応
- [ ] ランキング結果がスコア付きで返される
- [ ] *参考*: 論文ベンチマークでは平均検索レイテンシ 0.061 秒（LightRAG 11.052s, HippoRAG 1.586s の 180倍/26倍高速）

#### REQ-MG-043: コンテキスト構築・応答生成
**パターン**: EVENT-DRIVEN

```
WHEN グラフ伝播が完了した時、
THE MemGraphRAG システム SHALL
上位ランクのパッセージと Fact を統合してコンテキストを構築し、
LLM に渡して応答を生成する。
```

**受入基準**:
- [ ] パッセージと Fact が統合コンテキストとして整形される
- [ ] コンテキスト長の上限が設定可能
- [ ] 引用情報が応答に含まれる
- [ ] 応答の信頼度スコアが算出される

#### REQ-MG-044: フォールバック検索
**パターン**: COMPLEX

```
IF 構造的候補（Schema, Fact）が検索されなかった場合、
THEN THE MemGraphRAG システム SHALL
Passage Layer からの直接類似度検索にフォールバックし、
標準 RAG 方式で応答を生成する。
```

**受入基準**:
- [ ] フォールバック条件が自動判定される
- [ ] フォールバック時も応答品質が維持される
- [ ] フォールバック発生がログに記録される

#### REQ-MG-045: シソーラス・辞書連携クエリ拡張
**パターン**: EVENT-DRIVEN

```
WHEN 検索クエリが処理される時、
THE MemGraphRAG システム SHALL
専門用語辞書によるドメイン用語認識と
シソーラス辞書による同義語展開を組み合わせて、
クエリの意味的カバレッジを拡大する。
```

**受入基準**:
- [ ] ドメイン用語が認識・ブーストされる
- [ ] 同義語による検索拡張が実行される
- [ ] 拡張後のクエリが元の意図を保持する

#### REQ-MG-046: 検索結果メトリクス
**パターン**: EVENT-DRIVEN

```
WHEN 検索が完了した時、
THE MemGraphRAG システム SHALL
検索メトリクス（処理時間、検索候補数、フィルタ後候補数、
PPR 反復回数、フォールバック有無）を返却する。
```

**受入基準**:
- [ ] 上記メトリクスが結果オブジェクトに含まれる
- [ ] メトリクスが構造化データとして取得可能

---

### 2.6 MCP サーバーインターフェース (REQ-MG-070 〜 REQ-MG-079)

#### REQ-MG-070: MCP サーバー起動
**パターン**: EVENT-DRIVEN
**優先度**: Must | **パッケージ**: `memgraphrag-mcp-server`

```
WHEN MemGraphRAG MCP サーバーが起動された時、
THE MemGraphRAG システム SHALL
stdio トランスポートで MCP プロトコルに準拠したサーバーを起動し、
AIRA からのツール呼び出しを受け付ける。
```

**受入基準**:
- [ ] MCP プロトコル仕様に準拠した stdio サーバーが起動する
- [ ] AIRA の MCP 設定（`mcpServers` JSON）に登録可能
- [ ] サーバー起動時にグラフデータの読み込みが完了する
- [ ] 構造化エラーレスポンス（エラーコード + メッセージ + 詳細）が返される
- [ ] MCP エラーモデル: `INVALID_PARAMS`, `CORPUS_NOT_FOUND`, `PROVIDER_FAILURE`, `RATE_LIMITED`, `CORRUPTED_GRAPH`, `UNSUPPORTED_LANGUAGE`

#### REQ-MG-071: MCP ツール — create_corpus
**パターン**: EVENT-DRIVEN
**優先度**: Must | **パッケージ**: `memgraphrag-mcp-server`

```
WHEN AIRA が create_corpus ツールを MCP 経由で呼び出した時、
THE MemGraphRAG システム SHALL
新しいコーパス（ナレッジグラフの論理的分離単位）を作成し、
一意の corpus_id を返却する。
```

**受入基準**:
- [ ] パラメータ: `name` (コーパス名), `description` (任意), `config` (任意: 辞書/シソーラス設定)
- [ ] 一意の `corpus_id` が生成・返却される
- [ ] コーパスごとに独立した三層メモリ・グラフが管理される
- [ ] AIRA プロジェクト間でグラフが汚染されない

#### REQ-MG-071b: MCP ツール — delete_corpus
**パターン**: EVENT-DRIVEN
**優先度**: Must | **パッケージ**: `memgraphrag-mcp-server`

```
WHEN AIRA が delete_corpus ツールを MCP 経由で呼び出した時、
THE MemGraphRAG システム SHALL
指定されたコーパスの全データ（メモリ、グラフ、辞書、シソーラス）を削除する。
```

**受入基準**:
- [ ] パラメータ: `corpus_id`
- [ ] 該当コーパスの全データが削除される
- [ ] 存在しない corpus_id に対して `CORPUS_NOT_FOUND` エラーが返される

#### REQ-MG-071c: MCP ツール — list_corpora
**パターン**: EVENT-DRIVEN
**優先度**: Must | **パッケージ**: `memgraphrag-mcp-server`

```
WHEN AIRA が list_corpora ツールを MCP 経由で呼び出した時、
THE MemGraphRAG システム SHALL
既存コーパスの一覧（ID、名前、ドキュメント数、作成日時）を返却する。
```

**受入基準**:
- [ ] コーパス一覧が構造化データで返却される
- [ ] 各コーパスのドキュメント数・ノード数が含まれる

#### REQ-MG-072: MCP ツール — index_documents（非同期ジョブ）
**パターン**: EVENT-DRIVEN
**優先度**: Must | **パッケージ**: `memgraphrag-mcp-server`

```
WHEN AIRA が index_documents ツールを MCP 経由で呼び出した時、
THE MemGraphRAG システム SHALL
指定されたコーパスに対して、渡された Markdown テキスト（markitdown 変換済み）を受け取り、
非同期インデキシングジョブを開始し、ジョブ ID を即座に返却する。
```

**受入基準**:
- [ ] パラメータスキーマ:
  ```json
  {
    "corpus_id": "string (必須)",
    "documents": [
      {
        "document_id": "string (必須, 冪等キー)",
        "markdown": "string (必須, markitdown変換済みテキスト)",
        "title": "string (必須)",
        "source_url": "string (必須)",
        "doi": "string (任意)",
        "source_db": "string (任意, PubMed/arXiv/SemanticScholar等)",
        "source_type": "string (任意, pdf/html/docx)",
        "language": "string (任意, en/ja, 自動検出のフォールバック)"
      }
    ]
  }
  ```
- [ ] 同一 `document_id` の再送信は冪等（重複挿入されない）
- [ ] 同一 `doi` のドキュメントは重複として警告される
- [ ] ジョブ ID が即座に返却される（長時間処理はバックグラウンド）
- [ ] 構築結果（追加ノード数、エッジ数、衝突数、スキップ数）がジョブ完了時に取得可能

#### REQ-MG-072b: MCP ツール — get_job_status
**パターン**: EVENT-DRIVEN
**優先度**: Must | **パッケージ**: `memgraphrag-mcp-server`

```
WHEN AIRA が get_job_status ツールを MCP 経由で呼び出した時、
THE MemGraphRAG システム SHALL
指定されたジョブの進捗状況（pending/running/completed/failed/cancelled）、
処理済みドキュメント数、エラー詳細を返却する。
```

**受入基準**:
- [ ] パラメータ: `job_id`
- [ ] ステータス: `pending`, `running`, `completed`, `failed`, `cancelled`
- [ ] 進捗: `processed_count`, `total_count`, `error_count`, `errors[]`
- [ ] 完了時: 構築結果サマリー（ノード数、エッジ数、衝突数）

#### REQ-MG-072c: MCP ツール — cancel_job
**パターン**: EVENT-DRIVEN
**優先度**: Should | **パッケージ**: `memgraphrag-mcp-server`

```
WHEN AIRA が cancel_job ツールを MCP 経由で呼び出した時、
THE MemGraphRAG システム SHALL
指定されたジョブをキャンセルし、処理済み分のデータは保持する。
```

**受入基準**:
- [ ] パラメータ: `job_id`
- [ ] 処理済みドキュメントのデータは保持される（ロールバックしない）
- [ ] キャンセル後のステータスが `cancelled` になる

#### REQ-MG-072d: MCP ツール — delete_document
**パターン**: EVENT-DRIVEN
**優先度**: Must | **パッケージ**: `memgraphrag-mcp-server`

```
WHEN AIRA が delete_document ツールを MCP 経由で呼び出した時、
THE MemGraphRAG システム SHALL
指定されたドキュメントに由来する Passage、Fact、Schema 参照を
カスケード削除し、グラフの整合性を維持する。
```

**受入基準**:
- [ ] パラメータ: `corpus_id`, `document_id`
- [ ] 該当ドキュメントの Passage が全て削除される
- [ ] 該当 Passage のみに紐づく Fact が Inactive 化される
- [ ] Schema の頻度が再計算され、閾値未満は Pending に降格される
- [ ] 削除結果（削除 Passage 数、Inactive Fact 数）が返却される

#### REQ-MG-073: MCP ツール — query
**パターン**: EVENT-DRIVEN
**優先度**: Must | **パッケージ**: `memgraphrag-mcp-server`

```
WHEN AIRA が query ツールを MCP 経由で呼び出した時、
THE MemGraphRAG システム SHALL
指定されたコーパスの構築済み階層グラフに対してメモリガイド型検索を実行し、
応答テキストと引用情報を返却する。
```

**受入基準**:
- [ ] パラメータ: `corpus_id`, `query` (検索テキスト), `top_k` (任意, デフォルト: 10, パッセージ数), `top_m` (任意, デフォルト: 5, エンティティ数), `threshold` (任意, デフォルト: 0.5, 検索類似度閾値 τ_r に対応)
- [ ] 応答: `response` (テキスト), `citations` (引用配列), `entities` (関連エンティティ配列), `metrics` (検索メトリクス)
- [ ] 引用にソースドキュメントタイトル・URL・DOI・ソースDB が含まれる
- [ ] フォールバック検索が自動適用される
- [ ] 存在しない corpus_id に対して `CORPUS_NOT_FOUND` エラーが返される

#### REQ-MG-074: MCP ツール — get_stats
**パターン**: EVENT-DRIVEN
**優先度**: Should | **パッケージ**: `memgraphrag-mcp-server`

```
WHEN AIRA が get_stats ツールを MCP 経由で呼び出した時、
THE MemGraphRAG システム SHALL
指定されたコーパスのグローバルメモリとグラフの統計情報を返却する。
```

**受入基準**:
- [ ] パラメータ: `corpus_id`
- [ ] 三層メモリの各統計が返却される
- [ ] グラフ構造統計（ノード数、エッジ数、連結コンポーネント数）が返却される
- [ ] 辞書・シソーラスの統計が返却される
- [ ] ドキュメント一覧（ID, タイトル, 取り込み日時）が返却される

#### REQ-MG-075: MCP ツール — manage_dictionary
**パターン**: EVENT-DRIVEN
**優先度**: Must | **パッケージ**: `memgraphrag-mcp-server`

```
WHEN AIRA が manage_dictionary ツールを MCP 経由で呼び出した時、
THE MemGraphRAG システム SHALL
指定されたコーパスの辞書の追加、検索、統計表示を実行する。
```

**受入基準**:
- [ ] パラメータ: `corpus_id`, `action` (`add`, `search`, `stats`, `import`, `export`)
- [ ] `add`: 用語テキストとドメインカテゴリを受け取り辞書に追加
- [ ] `search`: キーワードによる辞書内検索
- [ ] `import`: JSON 形式の辞書データを一括インポート（インラインデータ、ファイルパス不使用）

#### REQ-MG-076: MCP ツール — manage_thesaurus
**パターン**: EVENT-DRIVEN
**優先度**: Must | **パッケージ**: `memgraphrag-mcp-server`

```
WHEN AIRA が manage_thesaurus ツールを MCP 経由で呼び出した時、
THE MemGraphRAG システム SHALL
指定されたコーパスのシソーラスの追加、検索、統計表示を実行する。
```

**受入基準**:
- [ ] パラメータ: `corpus_id`, `action` (`add`, `lookup`, `stats`, `import`, `export`)
- [ ] `add`: 用語ペアと関係タイプ（synonym/hypernym/hyponym/related）を受け取り追加
- [ ] `lookup`: 用語の同義語・関連語を返却
- [ ] `import`: JSON 形式のシソーラスデータを一括インポート（インラインデータ）

#### REQ-MG-077: MCP ツール — analyze_conflicts
**パターン**: EVENT-DRIVEN
**優先度**: Should | **パッケージ**: `memgraphrag-mcp-server`

```
WHEN AIRA が analyze_conflicts ツールを MCP 経由で呼び出した時、
THE MemGraphRAG システム SHALL
指定されたコーパスの検出済み衝突の一覧、衝突タイプ分布、解決状況を返却する。
```

**受入基準**:
- [ ] パラメータ: `corpus_id`
- [ ] 衝突リストが構造化データで返却される
- [ ] 衝突タイプ別の集計が含まれる
- [ ] 未解決衝突の詳細が含まれる

#### REQ-MG-078: MCP ツール — export_graph
**パターン**: EVENT-DRIVEN
**優先度**: Should | **パッケージ**: `memgraphrag-mcp-server`

```
WHEN AIRA が export_graph ツールを MCP 経由で呼び出した時、
THE MemGraphRAG システム SHALL
指定されたコーパスの階層グラフを GraphML または JSON 形式で
インラインデータとして返却する。
```

**受入基準**:
- [ ] パラメータ: `corpus_id`, `format` (`graphml`, `json`), `offset` (任意, デフォルト: 0), `limit` (任意, デフォルト: 10000)
- [ ] エクスポートデータがインライン（MCP レスポンス内）で返却される
- [ ] 大規模グラフ（ノード数 > limit）の場合はページネーション: `has_more`, `next_offset`, `total_nodes` を返却。ファイルパスは返却しない
- [ ] ノード・エッジのメタデータが含まれる

#### REQ-MG-079: MCP ツール — build_dictionary_from_api
**パターン**: OPTIONAL
**優先度**: Could | **パッケージ**: `memgraphrag-mcp-server`

```
WHERE Semantic Scholar API 連携機能が有効な場合、
WHEN AIRA が build_dictionary_from_api ツールを MCP 経由で呼び出した時、
THE MemGraphRAG システム SHALL
指定ドメインの学術論文から専門用語を自動収集し、辞書を構築する。
```

**受入基準**:
- [ ] パラメータ: `corpus_id`, `domains` (ドメインリスト), `max_papers` (最大論文数)
- [ ] Semantic Scholar API からの用語収集が実行される
- [ ] 構築結果（用語数、ドメイン分布）が返却される

#### REQ-MG-079b: AIRA MCP 設定テンプレート
**パターン**: UBIQUITOUS
**優先度**: Must | **パッケージ**: ドキュメント

```
THE MemGraphRAG システム SHALL
AIRA のプロジェクト MCP 設定に登録可能な JSON テンプレートを提供する。
```

**受入基準**:
- [ ] 以下の形式の AIRA 互換 MCP 設定テンプレートが提供される:
```json
{
  "mcpServers": {
    "memgraphrag": {
      "command": "node",
      "args": ["path/to/memgraphrag-mcp-server/dist/index.js"],
      "env": {
        "MEMGRAPHRAG_DATA_DIR": "./data/memgraphrag",
        "OPENAI_API_KEY": "${OPENAI_API_KEY}",
        "MEMGRAPHRAG_NLP_BACKEND": "python-sidecar"
      }
    }
  }
}
```
- [ ] 設定ドキュメントが提供される
- [ ] 環境変数の説明が含まれる

---

### 2.7 markitdown 連携 (REQ-MG-080 〜 REQ-MG-084)

#### REQ-MG-080: Markdown 入力の受け入れ
**パターン**: UBIQUITOUS

```
THE MemGraphRAG システム SHALL
markitdown で変換された Markdown テキストを主要な入力形式として受け入れ、
Markdown 構造（見出し、リスト、テーブル、コードブロック）を
セマンティックなチャンキングに活用する。
```

**受入基準**:
- [ ] Markdown テキストが直接入力として受け入れられる
- [ ] 見出し（#, ##, ###）がセクション境界として認識される
- [ ] テーブルが構造化データとして解析される
- [ ] コードブロックが適切にスキップまたは別処理される

#### REQ-MG-081: Markdown セマンティックチャンキング
**パターン**: EVENT-DRIVEN

```
WHEN markitdown 変換済みの Markdown テキストが入力された時、
THE MemGraphRAG システム SHALL
Markdown のセクション構造（見出しレベル）を活用した
セマンティックチャンキングを実行する。
```

**受入基準**:
- [ ] 見出しレベルに基づくセクション分割が実行される
- [ ] セクション階層（H1 > H2 > H3）がメタデータとして保持される
- [ ] チャンクサイズが設定可能（デフォルト: 600トークン）
- [ ] 長いセクションは更にサブチャンクに分割される
- [ ] チャンクに元セクションタイトルがメタデータとして付与される

#### REQ-MG-082: ドキュメントメタデータ保持
**パターン**: EVENT-DRIVEN

```
WHEN ドキュメントが index_documents で取り込まれた時、
THE MemGraphRAG システム SHALL
ソース情報（タイトル、URL、取得元DB、変換日時、言語）を
Passage Layer のメタデータとして保持する。
```

**受入基準**:
- [ ] ToolUniverse 取得元（PubMed, arXiv, Semantic Scholar 等）が記録される
- [ ] 元 PDF の URL / DOI が記録される
- [ ] markitdown 変換タイムスタンプが記録される
- [ ] メタデータが検索結果の引用情報に反映される

#### REQ-MG-083: markitdown 変換品質の検証
**パターン**: EVENT-DRIVEN
**優先度**: Should | **パッケージ**: `memgraphrag`

```
WHEN Markdown テキストが入力された時、
THE MemGraphRAG システム SHALL
テキストの品質を検証し、変換アーティファクト
（文字化け、不完全なテーブル、数式損失等）を検出・警告する。
```

**受入基準**:
- [ ] 空テキストまたは極端に短いテキスト（100文字未満）が警告される
- [ ] 文字化けパターン（制御文字の連続、U+FFFD 等）が検出される
- [ ] 不完全な Markdown 構造（閉じられていないテーブル等）が検出される
- [ ] 数式プレースホルダー（LaTeX 未変換パターン）が検出・フラグ付与される
- [ ] 図・画像のプレースホルダー（`![...](...)`）がメタデータとして記録される
- [ ] 参考文献セクション（References/Bibliography）が自動検出される
- [ ] 品質スコア（0-1）と品質フラグ配列が返却される

#### REQ-MG-084: バッチドキュメント取り込み
**パターン**: EVENT-DRIVEN

```
WHEN AIRA が複数ドキュメントのバッチ取り込みを要求した時、
THE MemGraphRAG システム SHALL
ToolUniverse 経由で取得し markitdown で変換された
複数ドキュメントを順次処理し、グローバルメモリに蓄積する。
```

**受入基準**:
- [ ] 複数ドキュメントが単一の MCP 呼び出しで処理可能
- [ ] 各ドキュメントの処理状況が進捗として報告される
- [ ] 処理済みドキュメント数と失敗数が返却される
- [ ] 途中エラーが全体処理を停止しない（スキップして継続）

---

### 2.8 NLP テキスト処理 (REQ-MG-050 〜 REQ-MG-055)

#### REQ-MG-050: バイリンガルテキスト処理
**パターン**: EVENT-DRIVEN

```
WHEN テキストが入力された時、
THE MemGraphRAG システム SHALL
テキストの言語（日本語/英語）を自動検出し、
適切な NLP モデルを選択してエンティティ・名詞句を抽出する。
```

**受入基準**:
- [ ] 日本語/英語の自動検出が実行される
- [ ] 英語: 科学論文特化モデル（scispaCy 相当）が使用される
- [ ] 日本語: GiNZA（Japanese NLP Library / spaCy ベース）が使用される
- [ ] 混合テキストが適切に処理される

#### REQ-MG-051: NLP エンジン抽象化（Python サイドカー対応）
**パターン**: UBIQUITOUS
**優先度**: Must | **パッケージ**: `memgraphrag`

```
THE MemGraphRAG システム SHALL
NLP エンティティ抽出を抽象インターフェース（INLPExtractor）で定義し、
SpaCy/scispaCy（Python サイドカープロセス経由）、LLM ベース抽出、
正規表現ベース抽出（JS ネイティブ）等の複数バックエンドに対応する。
```

**受入基準**:
- [ ] INLPExtractor インターフェースが定義される
- [ ] **Python サイドカーアダプター**: 子プロセスとして Python スクリプトを起動し、stdin/stdout JSON-RPC で SpaCy/scispaCy を呼び出す
- [ ] **LLM ベース抽出アダプター**: ILLMProvider 経由で LLM にエンティティ抽出を依頼する
- [ ] **JS ネイティブ正規表現アダプター**: Python 不要のフォールバック（基本的な名詞句パターンマッチ）
- [ ] バックエンドの切り替えが設定ファイル（`nlp_backend: "python-sidecar" | "llm" | "regex"`）で可能
- [ ] Python サイドカーの起動失敗時、JS ネイティブまたは LLM にフォールバックする
- [ ] Python サイドカーのヘルスチェック（起動確認、モデルロード確認）が実装される
- [ ] Python 環境の requirements（spacy, scispacy, モデル名）がドキュメント化される

#### REQ-MG-052: ハイブリッド抽出パイプライン
**パターン**: UBIQUITOUS

```
THE MemGraphRAG システム SHALL
NLP ベース抽出 → 辞書ブースト → シソーラス正規化 の
3段階パイプラインでエンティティを抽出し、
各段階の結果を統合する。
```

**受入基準**:
- [ ] 3段階のパイプラインが順次実行される
- [ ] 各段階の寄与度が追跡可能
- [ ] パイプライン段階の有効/無効が設定可能

#### REQ-MG-053: テキストチャンキング
**パターン**: EVENT-DRIVEN

```
WHEN ドキュメントが入力された時、
THE MemGraphRAG システム SHALL
テキストを意味的に一貫したチャンクに分割する。
チャンクサイズとオーバーラップが設定可能であること。
```

**受入基準**:
- [ ] チャンクサイズ（トークン数）が設定可能（デフォルト: 600）
- [ ] オーバーラップ比率が設定可能（デフォルト: 100）
- [ ] 文境界でのチャンク分割が実行される
- [ ] メタデータ（チャンクID、元ドキュメントID、位置情報）が付与される

#### REQ-MG-054: エンベディング生成
**パターン**: UBIQUITOUS

```
THE MemGraphRAG システム SHALL
テキスト・エンティティ・Schema のエンベディング生成を
抽象インターフェースで定義し、
OpenAI, Azure OpenAI, ローカルモデル等に対応する。
```

**受入基準**:
- [ ] IEmbeddingProvider インターフェースが定義される
- [ ] OpenAI / Azure OpenAI アダプターが提供される
- [ ] バッチエンベディング生成が可能
- [ ] エンベディングのキャッシュが実装される

#### REQ-MG-055: テキスト前処理
**パターン**: EVENT-DRIVEN

```
WHEN テキストが入力された時、
THE MemGraphRAG システム SHALL
テキストの正規化（Unicode正規化、空白正規化、制御文字除去）を実行する。
```

**受入基準**:
- [ ] Unicode 正規化（NFKC）が実行される
- [ ] 連続空白の正規化が実行される
- [ ] 制御文字の除去が実行される

---

### 2.9 CLI インターフェース (REQ-MG-060 〜 REQ-MG-067)

#### REQ-MG-060: インデックス構築コマンド
**パターン**: EVENT-DRIVEN

```
WHEN ユーザーが `memgraphrag index` コマンドを実行した時、
THE MemGraphRAG システム SHALL
指定されたドキュメントディレクトリからグラフを構築し、
結果を指定された出力ディレクトリに保存する。
```

**受入基準**:
- [ ] 入力ディレクトリ指定が可能（`--input`）
- [ ] 出力ディレクトリ指定が可能（`--output`）
- [ ] 設定ファイル指定が可能（`--config`）
- [ ] 進捗表示が行われる
- [ ] 処理完了後に統計サマリーが表示される

#### REQ-MG-061: クエリコマンド
**パターン**: EVENT-DRIVEN

```
WHEN ユーザーが `memgraphrag query` コマンドを実行した時、
THE MemGraphRAG システム SHALL
構築済みグラフに対してクエリを実行し、応答を生成する。
```

**受入基準**:
- [ ] クエリテキスト指定が可能（`--query`）
- [ ] グラフディレクトリ指定が可能（`--graph`）
- [ ] 検索パラメータ指定が可能（`--top-k`, `--threshold`）
- [ ] 応答と引用が表示される

#### REQ-MG-062: 辞書管理コマンド
**パターン**: EVENT-DRIVEN

```
WHEN ユーザーが `memgraphrag dictionary` コマンドを実行した時、
THE MemGraphRAG システム SHALL
辞書の構築、更新、インポート、エクスポート、統計表示を実行する。
```

**受入基準**:
- [ ] `dictionary build` サブコマンド（Semantic Scholar API から構築）
- [ ] `dictionary import` サブコマンド（JSON インポート）
- [ ] `dictionary export` サブコマンド（JSON エクスポート）
- [ ] `dictionary stats` サブコマンド（統計表示）

#### REQ-MG-063: シソーラス管理コマンド
**パターン**: EVENT-DRIVEN

```
WHEN ユーザーが `memgraphrag thesaurus` コマンドを実行した時、
THE MemGraphRAG システム SHALL
シソーラスのインポート、エクスポート、検索、統計表示を実行する。
```

**受入基準**:
- [ ] `thesaurus import` サブコマンド
- [ ] `thesaurus export` サブコマンド
- [ ] `thesaurus lookup <term>` サブコマンド
- [ ] `thesaurus stats` サブコマンド

#### REQ-MG-064: メモリ統計コマンド
**パターン**: EVENT-DRIVEN

```
WHEN ユーザーが `memgraphrag stats` コマンドを実行した時、
THE MemGraphRAG システム SHALL
グローバルメモリの統計情報を表示する。
```

**受入基準**:
- [ ] 三層メモリの各統計が表示される
- [ ] グラフ構造統計（ノード数、エッジ数、連結コンポーネント数）が表示される
- [ ] JSON / テーブル形式での出力が選択可能

#### REQ-MG-065: 設定初期化コマンド
**パターン**: EVENT-DRIVEN

```
WHEN ユーザーが `memgraphrag init` コマンドを実行した時、
THE MemGraphRAG システム SHALL
デフォルト設定ファイル（YAML）を生成する。
```

**受入基準**:
- [ ] デフォルト設定ファイルが生成される
- [ ] 全設定項目にコメントが付与される

#### REQ-MG-066: グラフ可視化コマンド
**パターン**: OPTIONAL

```
WHERE グラフ可視化機能が有効な場合、
WHEN ユーザーが `memgraphrag visualize` コマンドを実行した時、
THE MemGraphRAG システム SHALL
階層グラフの構造を GraphML 形式でエクスポートする。
```

**受入基準**:
- [ ] GraphML 形式でのエクスポートが可能
- [ ] ノード・エッジのメタデータが含まれる

#### REQ-MG-067: 衝突分析コマンド
**パターン**: EVENT-DRIVEN

```
WHEN ユーザーが `memgraphrag conflicts` コマンドを実行した時、
THE MemGraphRAG システム SHALL
検出済み衝突の一覧、衝突タイプ分布、解決状況を表示する。
```

**受入基準**:
- [ ] 衝突リストが表示される
- [ ] 衝突タイプ別の分布が表示される
- [ ] 未解決衝突がハイライトされる

---

## 3. 非機能要件

### 3.1 パフォーマンス (REQ-MG-NF-001 〜 REQ-MG-NF-003)

#### REQ-MG-NF-001: インデキシングスループット
**パターン**: UBIQUITOUS
**優先度**: Must

```
THE MemGraphRAG システム SHALL
インデキシング処理の各ステージにおいて以下のスループットを達成する。
```

**受入基準**:
- [ ] Markdown パース + チャンキング: 100 ドキュメント/秒以上（平均 5KB/doc）
- [ ] NLP エンティティ抽出（Python サイドカー）: 10 チャンク/秒以上（600トークン/チャンク）
- [ ] 辞書ブースト + シソーラス正規化: 1,000 エンティティ/秒以上
- [ ] LLM ベース Schema/Fact 抽出: LLM API レイテンシに依存（除外対象として明記）
- [ ] エンベディング生成: API レイテンシに依存（除外対象として明記）
- [ ] 上記メトリクスがベンチマークテストで検証可能であること

#### REQ-MG-NF-002: メモリ使用量
**パターン**: UBIQUITOUS
**優先度**: Must

```
THE MemGraphRAG システム SHALL
1,000 ドキュメント以下のコーパスにおいて、
MCP サーバープロセスのメモリ使用量を 4GB 以下に抑える
（Python サイドカープロセスのメモリは別計上）。
```

**受入基準**:
- [ ] TypeScript MCP サーバー: 4GB 以下
- [ ] Python NLP サイドカー: 2GB 以下（scispaCy モデル含む）
- [ ] メモリリークがないこと（長時間稼働テストで検証）

#### REQ-MG-NF-003: クエリ応答時間
**パターン**: UBIQUITOUS
**優先度**: Must

```
THE MemGraphRAG システム SHALL
1,000 ドキュメント規模のコーパスに対するクエリにおいて、
LLM 呼び出し時間を除くグラフ検索・コンテキスト構築を 3 秒以内に完了する。
```

**受入基準**:
- [ ] メモリフィルタリング（三層並列 Top-K 検索）: 500ms 以内
- [ ] PPR グラフ伝播（λ=0.5, 収束まで）: 1,000ms 以内
- [ ] コンテキスト構築: 500ms 以内
- [ ] 合計（LLM 除外）: 3 秒以内
- [ ] **論文ベンチマーク参考**: 原論文では平均 0.061 秒/クエリ（ただし GPT-4o-mini + NV-Embed-v2 環境）
- [ ] 上記がベンチマークテストで検証可能であること

### 3.2 永続化・ストレージ (REQ-MG-NF-008 〜 REQ-MG-NF-010)

#### REQ-MG-NF-008: ストレージ抽象化
**パターン**: UBIQUITOUS
**優先度**: Must

```
THE MemGraphRAG システム SHALL
グラフストア、ベクトルインデックス、メモリ永続化を
IGraphStore / IVectorIndex / IMemoryStore の抽象インターフェースで定義し、
実装を差し替え可能とする。
```

**受入基準**:
- [ ] IGraphStore: グラフ隣接データの提供、およびノード/エッジの CRUD を担う
- [ ] IGraphProjection: row-stochastic な遷移反復の提供、およびダングリングノード列挙を担う
- [ ] IPPR: IGraphProjection を入力として Personalized PageRank を実行する
- [ ] IVectorIndex: エンベディングの追加/検索（Top-K 類似度検索）
- [ ] IMemoryStore: 三層メモリの永続化/復元
- [ ] デフォルト実装: SQLite（グラフ + メタデータ）+ ファイルベースベクトルインデックス
- [ ] JSON エクスポート/インポートは永続化とは別にデータ交換用として提供

#### REQ-MG-NF-009: データ整合性
**パターン**: UBIQUITOUS
**優先度**: Must

```
THE MemGraphRAG システム SHALL
書き込み操作をアトミックに実行し、
プロセスクラッシュ時にデータ破損が発生しないことを保証する。
```

**受入基準**:
- [ ] SQLite WAL モードによるアトミック書き込み
- [ ] インデキシングジョブのチェックポイント（ドキュメント単位）
- [ ] 起動時の整合性チェック + 自動修復

#### REQ-MG-NF-010: スキーマバージョニング
**パターン**: EVENT-DRIVEN
**優先度**: Should

```
WHEN ストレージスキーマが変更された時、
THE MemGraphRAG システム SHALL
マイグレーションを自動実行し、既存データを新スキーマに変換する。
```

**受入基準**:
- [ ] スキーマバージョンが記録される
- [ ] バージョン差分に応じたマイグレーションが自動実行される
- [ ] マイグレーション失敗時にロールバックが可能

### 3.3 スケーラビリティ (REQ-MG-NF-004)

#### REQ-MG-NF-004: 線形スケーリング
**パターン**: UBIQUITOUS
**優先度**: Must

```
THE MemGraphRAG システム SHALL
ドキュメント数に対して NLP 処理時間およびストレージサイズが
線形にスケールすること。
```

**受入基準**:
- [ ] 10/100/500/1000 ドキュメントでの処理時間が線形比例（±20%）
- [ ] ストレージサイズがドキュメント数に比例
- [ ] **衝突検出の計算量制御**: ベクトルインデックス + 候補上限 L_conf（デフォルト: 100）により、Fact 増加時もスキャンが O(log N + L_conf) に制限される
- [ ] **ブリッジングの計算量制御**: エンティティごとの候補上限 L_bridge（デフォルト: 50）+ ANN（近似最近傍）検索により、O(N²) ペアワイズ比較を回避
- [ ] 上記がベンチマークテストで検証可能であること

### 3.4 拡張性 (REQ-MG-NF-005)

#### REQ-MG-NF-005: プラグイン可能なバックエンド
**パターン**: UBIQUITOUS
**優先度**: Must

```
THE MemGraphRAG システム SHALL
NLP エンジン、LLM プロバイダー、エンベディングプロバイダー、
ストレージバックエンドをインターフェースベースのプラグインとして差し替え可能とする。
```

**受入基準**:
- [ ] 各プロバイダーのインターフェースが明確に定義される
- [ ] 設定ファイルでバックエンドを指定可能
- [ ] 新バックエンドの追加にコア変更が不要

### 3.5 信頼性 (REQ-MG-NF-006)

#### REQ-MG-NF-006: 中断耐性
**パターン**: EVENT-DRIVEN
**優先度**: Must

```
WHEN グラフ構築ジョブが中断された時、
THE MemGraphRAG システム SHALL
ドキュメント単位のチェックポイントに基づき、
次回実行時に未処理ドキュメントから処理を再開できる。
```

**受入基準**:
- [ ] 各ドキュメント処理完了時にチェックポイントが記録される
- [ ] ジョブ再開時に未処理ドキュメントのみが処理される
- [ ] 処理済みドキュメントの重複処理が発生しない

### 3.6 テスト (REQ-MG-NF-007)

#### REQ-MG-NF-007: テストカバレッジ
**パターン**: UBIQUITOUS
**優先度**: Must

```
THE MemGraphRAG システム SHALL
ユニットテストのブランチカバレッジが 80% 以上であること。
```

**受入基準**:
- [ ] Vitest によるブランチカバレッジが 80% 以上
- [ ] MCP ツール全てに統合テストが存在する
- [ ] Python サイドカーのモック付きテストが存在する

### 3.7 セキュリティ (REQ-MG-NF-011 〜 REQ-MG-NF-016)

#### REQ-MG-NF-011: 入力バリデーション
**パターン**: UBIQUITOUS
**優先度**: Must

```
THE MemGraphRAG システム SHALL
全ての MCP ツール入力に対してサイズ制限、型検証、
サニタイゼーションを実行する。
```

**受入基準**:
- [ ] ドキュメントテキストのサイズ上限が設定可能（デフォルト: 10MB/ドキュメント）
- [ ] バッチサイズ上限が設定可能（デフォルト: 100 ドキュメント/リクエスト）
- [ ] JSON スキーマによるパラメータ型検証
- [ ] パストラバーサル攻撃の防止（ファイルパス入力がある場合）

#### REQ-MG-NF-012: API キー管理
**パターン**: UBIQUITOUS
**優先度**: Must

```
THE MemGraphRAG システム SHALL
LLM / エンベディング / Semantic Scholar API のキーを
環境変数経由でのみ受け取り、ログ・エラーメッセージ・
エクスポートデータに含めない。
```

**受入基準**:
- [ ] API キーが環境変数から読み込まれる
- [ ] ログ出力に API キーが含まれない
- [ ] エラーメッセージに API キーが含まれない

#### REQ-MG-NF-013: ローカルオンリーモード
**パターン**: OPTIONAL
**優先度**: Should

```
WHERE ローカルオンリーモードが有効な場合、
THE MemGraphRAG システム SHALL
外部 API（LLM, エンベディング, Semantic Scholar）への通信を
全て遮断し、利用可能なローカルリソースのみで動作する。
```

**受入基準**:
- [ ] 設定フラグ `local_only: true` で有効化
- [ ] 外部 API 呼び出しが発生しない
- [ ] **劣化動作の明示**:
  - エンティティ抽出: JS ネイティブ正規表現 + Python サイドカー（ローカル spaCy）にフォールバック
  - エンベディング: ローカルモデル（IEmbeddingProvider のローカル実装）が必須。未設定の場合はエラー `LOCAL_EMBEDDING_REQUIRED`
  - Schema/Fact 抽出: LLM 不在のため正規表現ベースの簡易抽出。品質劣化が発生
  - PPR ノード初期化: エンベディングが利用不可の場合、BM25 ベースの初期化にフォールバック
  - 衝突検出: シンボリックマッチング Match() のみ（意味的類似度スキャンは不可）
- [ ] 非対応操作の呼び出し時に構造化エラー `FEATURE_REQUIRES_API` が返される
- [ ] 起動時にローカルモードの機能制限サマリーがログに出力される

#### REQ-MG-NF-014: 監査ログ
**パターン**: UBIQUITOUS
**優先度**: Should

```
THE MemGraphRAG システム SHALL
コーパス作成/削除、ドキュメント追加/削除、辞書変更の操作を
タイムスタンプ付きで監査ログに記録する。
```

**受入基準**:
- [ ] 操作種別、対象 ID、タイムスタンプが記録される
- [ ] ログが構造化形式（JSON Lines）で出力される

#### REQ-MG-NF-015: 安全なエラーメッセージ
**パターン**: UBIQUITOUS
**優先度**: Must

```
THE MemGraphRAG システム SHALL NOT
エラーレスポンスに内部パス、スタックトレース、
設定詳細等の機密情報を含めない。
```

**受入基準**:
- [ ] MCP エラーレスポンスにファイルパスが含まれない
- [ ] スタックトレースが開発モード以外で露出しない

#### REQ-MG-NF-016: ドキュメントアクセス制御
**パターン**: UBIQUITOUS
**優先度**: Must

```
THE MemGraphRAG システム SHALL
コーパス間のデータ分離を保証し、
あるコーパスのクエリが別コーパスのデータにアクセスしないことを保証する。
```

**受入基準**:
- [ ] 全クエリが corpus_id でスコープされる
- [ ] クロスコーパスのデータリークがないことがテストで検証される

### 3.8 オブザーバビリティ (REQ-MG-NF-017 〜 REQ-MG-NF-018)

#### REQ-MG-NF-017: 構造化ログ
**パターン**: UBIQUITOUS
**優先度**: Must

```
THE MemGraphRAG システム SHALL
全処理ステージ（チャンキング、NLP 抽出、辞書ブースト、
衝突検出、グラフ構築、検索）の処理時間と結果を
構造化ログ（JSON Lines）で出力する。
```

**受入基準**:
- [ ] 各ステージの処理時間がログに含まれる
- [ ] LLM 呼び出し回数・トークン使用量がログに含まれる
- [ ] エンベディングキャッシュヒット率がログに含まれる
- [ ] ログレベル（debug/info/warn/error）が設定可能

#### REQ-MG-NF-018: メトリクス
**パターン**: UBIQUITOUS
**優先度**: Should

```
THE MemGraphRAG システム SHALL
インデキシングジョブおよびクエリの実行メトリクスを
get_stats ツール経由で取得可能とする。
```

**受入基準**:
- [ ] 累計インデキシング時間、ドキュメント数、エラー数
- [ ] 累計クエリ数、平均応答時間
- [ ] 辞書ブースト適用率、シソーラス正規化率
- [ ] 衝突検出数、解決数

---

## 4. 要件トレーサビリティマトリクス

### 優先度定義

| 優先度 | 定義 | MVP 含む |
|--------|------|----------|
| **Must** | MVP に必須。これなしでは動作しない | ✅ |
| **Should** | 品質・利便性に重要。MVP 後の第2フェーズで実装 | — |
| **Could** | あれば良い。リソースに余裕がある場合に実装 | — |

### 機能要件

| 要件ID | カテゴリ | 優先度 | ステータス |
|--------|----------|--------|----------|
| REQ-MG-001 | グローバルメモリ - Ontology | Must | Draft |
| REQ-MG-002 | グローバルメモリ - Fact | Must | Draft |
| REQ-MG-003 | グローバルメモリ - Passage | Must | Draft |
| REQ-MG-004 | グローバルメモリ - インデキシング | Must | Draft |
| REQ-MG-005 | グローバルメモリ - スナップショット/データ交換 | Must | Draft |
| REQ-MG-006 | グローバルメモリ - 統計 | Should | Draft |
| REQ-MG-010 | エージェント - 抽出 | Must | Draft |
| REQ-MG-010b | エージェント - Schema正規化 | Must | Draft |
| REQ-MG-011 | エージェント - 衝突検出 | Must | Draft |
| REQ-MG-012 | エージェント - 衝突解決 | Must | Draft |
| REQ-MG-013 | エージェント - ノイズ除去 | Must | Draft |
| REQ-MG-014 | エージェント - 構造統合 | Should | Draft |
| REQ-MG-015 | エージェント - グラフ構築 | Must | Draft |
| REQ-MG-016 | エージェント - インクリメンタル | Should | Draft |
| REQ-MG-017 | エージェント - バッチ処理 | Must | Draft |
| REQ-MG-018 | エージェント - LLM抽象化 | Must | Draft |
| REQ-MG-020 | 専門用語辞書 - データモデル | Must | Draft |
| REQ-MG-021 | 専門用語辞書 - API連携 | Could | Draft |
| REQ-MG-022 | 専門用語辞書 - ブースト抽出 | Must | Draft |
| REQ-MG-023 | 専門用語辞書 - カスタム登録 | Must | Draft |
| REQ-MG-024 | 専門用語辞書 - 自動学習 | Could | Draft |
| REQ-MG-025 | 専門用語辞書 - 統計 | Should | Draft |
| REQ-MG-026 | 専門用語辞書 - エクスポート | Should | Draft |
| REQ-MG-030 | シソーラス - データモデル | Must | Draft |
| REQ-MG-031 | シソーラス - 正規化 | Must | Draft |
| REQ-MG-032 | シソーラス - グラフ拡張 | Could | Draft |
| REQ-MG-033 | シソーラス - 衝突検出向上 | Should | Draft |
| REQ-MG-034 | シソーラス - クエリ拡張 | Should | Draft |
| REQ-MG-035 | シソーラス - カスタム登録 | Must | Draft |
| REQ-MG-036 | シソーラス - 自動推定 | Could | Draft |
| REQ-MG-040 | 検索 - メモリフィルタリング | Must | Draft |
| REQ-MG-041 | 検索 - ノード初期化 | Must | Draft |
| REQ-MG-042 | 検索 - PPR | Must | Draft |
| REQ-MG-043 | 検索 - 応答生成 | Must | Draft |
| REQ-MG-044 | 検索 - フォールバック | Must | Draft |
| REQ-MG-045 | 検索 - 辞書連携拡張 | Should | Draft |
| REQ-MG-046 | 検索 - メトリクス | Should | Draft |
| REQ-MG-050 | NLP - バイリンガル | Must | Draft |
| REQ-MG-051 | NLP - エンジン抽象化 (Python サイドカー) | Must | Draft |
| REQ-MG-052 | NLP - ハイブリッドパイプライン | Must | Draft |
| REQ-MG-053 | NLP - チャンキング | Must | Draft |
| REQ-MG-054 | NLP - エンベディング | Must | Draft |
| REQ-MG-055 | NLP - 前処理 | Must | Draft |
| REQ-MG-060 | CLI - インデックス | Should | Draft |
| REQ-MG-061 | CLI - クエリ | Should | Draft |
| REQ-MG-062 | CLI - 辞書管理 | Should | Draft |
| REQ-MG-063 | CLI - シソーラス管理 | Should | Draft |
| REQ-MG-064 | CLI - 統計 | Should | Draft |
| REQ-MG-065 | CLI - 初期化 | Should | Draft |
| REQ-MG-066 | CLI - 可視化 | Could | Draft |
| REQ-MG-067 | CLI - 衝突分析 | Could | Draft |
| REQ-MG-070 | MCP - サーバー起動 | Must | Draft |
| REQ-MG-071 | MCP - create_corpus | Must | Draft |
| REQ-MG-071b | MCP - delete_corpus | Must | Draft |
| REQ-MG-071c | MCP - list_corpora | Must | Draft |
| REQ-MG-072 | MCP - index_documents (非同期) | Must | Draft |
| REQ-MG-072b | MCP - get_job_status | Must | Draft |
| REQ-MG-072c | MCP - cancel_job | Should | Draft |
| REQ-MG-072d | MCP - delete_document | Must | Draft |
| REQ-MG-073 | MCP - query | Must | Draft |
| REQ-MG-074 | MCP - get_stats | Should | Draft |
| REQ-MG-075 | MCP - manage_dictionary | Must | Draft |
| REQ-MG-076 | MCP - manage_thesaurus | Must | Draft |
| REQ-MG-077 | MCP - analyze_conflicts | Should | Draft |
| REQ-MG-078 | MCP - export_graph | Should | Draft |
| REQ-MG-079 | MCP - build_dictionary_from_api | Could | Draft |
| REQ-MG-079b | MCP - AIRA設定テンプレート | Must | Draft |
| REQ-MG-080 | markitdown - Markdown入力 | Must | Draft |
| REQ-MG-081 | markitdown - セマンティックチャンキング | Must | Draft |
| REQ-MG-082 | markitdown - メタデータ保持 | Must | Draft |
| REQ-MG-083 | markitdown - 品質検証 | Should | Draft |
| REQ-MG-084 | markitdown - バッチ取り込み | Must | Draft |

### 非機能要件

| 要件ID | カテゴリ | 優先度 | ステータス |
|--------|----------|--------|----------|
| REQ-MG-NF-001 | NFR - スループット | Must | Draft |
| REQ-MG-NF-002 | NFR - メモリ | Must | Draft |
| REQ-MG-NF-003 | NFR - 応答時間 | Must | Draft |
| REQ-MG-NF-004 | NFR - スケーラビリティ | Must | Draft |
| REQ-MG-NF-005 | NFR - 拡張性 | Must | Draft |
| REQ-MG-NF-006 | NFR - 中断耐性 | Must | Draft |
| REQ-MG-NF-007 | NFR - テストカバレッジ | Must | Draft |
| REQ-MG-NF-008 | NFR - ストレージ抽象化 | Must | Draft |
| REQ-MG-NF-009 | NFR - データ整合性 | Must | Draft |
| REQ-MG-NF-010 | NFR - スキーマバージョニング | Should | Draft |
| REQ-MG-NF-011 | NFR - 入力バリデーション | Must | Draft |
| REQ-MG-NF-012 | NFR - APIキー管理 | Must | Draft |
| REQ-MG-NF-013 | NFR - ローカルオンリーモード | Should | Draft |
| REQ-MG-NF-014 | NFR - 監査ログ | Should | Draft |
| REQ-MG-NF-015 | NFR - 安全なエラーメッセージ | Must | Draft |
| REQ-MG-NF-016 | NFR - コーパス分離 | Must | Draft |
| REQ-MG-NF-017 | NFR - 構造化ログ | Must | Draft |
| REQ-MG-NF-018 | NFR - メトリクス | Should | Draft |

### MVP スコープサマリー (Must のみ)

| カテゴリ | Must 要件数 | 概要 |
|----------|------------|------|
| グローバルメモリ | 5 | 三層メモリ + インデキシング + スナップショット |
| エージェント | 8 | 抽出、Schema正規化、衝突検出、衝突解決、ノイズ除去、グラフ構築、バッチ、LLM抽象化 |
| 専門用語辞書 | 3 | データモデル、ブースト、カスタム登録 |
| シソーラス | 3 | データモデル、正規化、カスタム登録 |
| 検索 | 5 | フィルタリング、ノード初期化、PPR、応答生成、フォールバック |
| NLP | 6 | バイリンガル、エンジン抽象化、パイプライン、チャンキング、エンベディング、前処理 |
| MCP | 11 | サーバー、コーパスCRUD、インデキシング（非同期）、クエリ、辞書、シソーラス、設定 |
| markitdown | 4 | Markdown入力、チャンキング、メタデータ、バッチ |
| NFR | 14 | パフォーマンス、ストレージ、セキュリティ、ログ |
| **合計** | **59** | |

---

## 5. 差分分析：原論文 vs 本実装

本実装は MemGraphRAG 原論文のアーキテクチャを基盤としつつ、以下の独自拡張を行う。

| 領域 | 原論文 | 本実装（拡張） |
|------|--------|----------------|
| **システム統合** | スタンドアロン | AIRA エコシステム内 MCP サーバー |
| **入力形式** | 生テキスト | markitdown 変換 Markdown（PDF/PPTX/DOCX/HTML 対応） |
| **論文取得** | 手動 | ToolUniverse MCP 経由で 89 DB から自動取得 |
| **インターフェース** | CLI / API | MCP プロトコル + CLI |
| **エンティティ抽出** | LLM ベースのみ (GPT-4o-mini) | ハイブリッド（NLP + 辞書 + LLM） |
| **用語認識** | 汎用 | 専門用語辞書によるブースト（+36.5%品質向上, Qiita実験） |
| **表記揺れ対応** | なし | シソーラス辞書による正規化・同義語展開 |
| **言語対応** | 英語のみ（推定） | 日英バイリンガル（scispaCy + GiNZA） |
| **クエリ拡張** | LLM ベース | LLM + シソーラス + 辞書ハイブリッド |
| **衝突検出** | 意味的類似度 + シンボリックマッチ | 意味的類似度 + シンボリック + シソーラス距離 |
| **コスト** | LLM 依存（GPT-4o-mini 全抽出） | NLP ベース抽出でコスト削減可能 |
| **チャンキング** | 固定長テキスト分割 | Markdown セマンティックチャンキング（見出し構造活用） |
| **実装言語** | Python（推定） | TypeScript (MUSUBIX2 準拠) + Python サイドカー |
| **引用管理** | 基本的 | ソースDB・URL・DOI 付きフルトレーサビリティ |
| **エンベディング** | NV-Embed-v2 | プロバイダー抽象化（OpenAI, Azure, ローカル対応） |
| **永続化** | 未公開 | SQLite + ファイルベースベクトルインデックス |

### 5.1 論文ベンチマーク結果（参考値）

原論文の実験結果を参考値として記録する。本実装は独自拡張を含むため、同一結果を保証するものではない。

| 指標 | MemGraphRAG | 最強ベースライン | 改善幅 |
|------|-------------|----------------|--------|
| **平均精度** (8データセット) | 58.41% | 56.16% (E2GraphRAG) | +2.25% |
| **HotpotQA** (LLM-Acc) | 69.40% | 67.30% (HippoRAG2) | +2.10% |
| **2WikiMultiHopQA** | 70.05% | 66.80% (E2GraphRAG) | +3.25% |
| **MuSiQue** | 36.15% | 33.90% (HippoRAG2) | +2.25% |
| **G-Medical** | 68.40% | 69.00% (HippoRAG2) | -0.60% |
| **検索レイテンシ** | 0.061s | 1.586s (HippoRAG) | 26倍高速 |
| **グラフ品質（次数）** | 8.92〜14.37 | 1.48〜13.31 | 最高密度 |
| **グラフ品質（CC）** | 0.527〜0.865 | 0.087〜0.657 | 最高結合度 |

*データセット: HotpotQA, 2WikiMultiHopQA, MuSiQue, G-Medical, G-Novel (Contain-Acc, LLM-Acc)*
*LLM: GPT-4o-mini, Embeddings: NV-Embed-v2*

---

## 6. エンドツーエンド利用シナリオ

### シナリオ 1: 研究テーマに関する論文ナレッジグラフ構築

```
1. 研究者が AIRA で新規プロジェクトを作成
2. AIRA の MCP 設定に MemGraphRAG を追加
3. 研究者: 「Transformer の注意機構に関する論文を集めてナレッジグラフを構築して」
4. AIRA → ToolUniverse MCP: Semantic Scholar / arXiv で論文検索
5. AIRA → markitdown: 取得した PDF を Markdown に変換
6. AIRA → MemGraphRAG MCP (index_documents):
   - Markdown テキスト + メタデータ（タイトル, URL, ソースDB）を送信
   - MemGraphRAG が三層メモリ + マルチエージェントでグラフ構築
   - 専門用語辞書でドメイン用語をブースト
   - シソーラスで表記揺れを正規化
7. AIRA → MemGraphRAG MCP (query):
   - 「Self-attention と Multi-head attention の関係は？」
   - MemGraphRAG が PPR ベースの階層検索で応答
   - 引用付き（[Source: "Attention Is All You Need", arXiv:1706.03762]）
```

### シナリオ 2: 辞書・シソーラスの事前構築

```
1. 研究者: 「深層学習分野の専門用語辞書を構築して」
2. AIRA → MemGraphRAG MCP (build_dictionary_from_api):
   - domains: ["deep learning", "neural networks", "transformer"]
   - Semantic Scholar API から用語自動収集
3. AIRA → MemGraphRAG MCP (manage_thesaurus / import):
   - カスタムシソーラス JSON をインポート
   - "ML" ↔ "machine learning", "DL" ↔ "deep learning" 等
4. 以降の index_documents で構築済み辞書・シソーラスが自動適用
```

---

## 7. 変更履歴

| バージョン | 日付 | 変更内容 |
|-----------|------|----------|
| 1.0 | 2026-06-07 | 初版: 89要件（三層メモリ、エージェント、辞書/シソーラス、検索、MCP、markitdown、NLP、CLI、NFR） |
| 1.0.1 | 2026-06-07 | Rubber-duck レビュー反映: コーパス分離、非同期ジョブ、Python サイドカー、セキュリティ、オブザーバビリティ追加 |
| 1.1 | 2026-06-08 | 論文 markitdown 版精読結果反映: Algorithm 1 全4ステージの数式(式9-16)を受入基準に統合、PPR パラメータ修正(α=0.85→λ=0.5)、Hub Suppression/IDF density の正式定義追加、衝突3分類の正式定義追加、ベンチマーク参考値(Table 4/5)追加、パラメータ一覧(§1.7)追加、用語定義拡充 |
| 1.2 | 2026-06-08 | Rubber-duck v2 反映(15件): τ_r/τ分離+§1.7完備(#1), Hub Suppression除零修正log(deg+2)+SchemaRelevance/σ/W定義(#2), Schema正規化REQ-MG-010b新設(#3), 衝突スキャンをM_fac_active限定+L_conf候補上限(#4), REQ-MG-005をスナップショット/データ交換に変更(#5), REQ-MG-011/012をMust昇格(#6), export_graphページネーション化(#7), index_documentsスキーマ明示化(#8), NF-004にANN/候補上限制約追加(#9), 衝突解決に6状態+unresolved追加(#10), top_m/M追加(#11), ローカルオンリー劣化動作明示(#12), EARSパターン正規化(#13), §1.7パラメータ完備(#14), ベンチマーク値を参考ラベル化(#15) |

---

**End of Document**
