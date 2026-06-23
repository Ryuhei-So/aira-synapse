---
title: '学術論文のためのRAGシステム — aira-synapse と専用グラフDB aira-graphdb をゼロから作った話'
tags:
  - GraphRAG
  - RAG
  - TypeScript
  - KnowledgeGraph
  - Rust
private: false
updated_at: '2026-06-23'
---

# 学術論文のためのRAGシステム — aira-synapse と専用グラフDB aira-graphdb をゼロから作った話

> **TL;DR**
> - 学術論文の知見を統合する RAG を作るとき、Classic RAG では **マルチホップ推論・エンティティ同一性・矛盾検出** で力不足
> - Microsoft GraphRAG はコミュニティ要約が強いが Factoid QA に弱い (HotpotQA Str-Acc 51.6%)
> - 論文 MemGraphRAG (KDD 2026) を TypeScript でクリーンルーム実装したのが **aira-synapse**
> - 当初は Neo4j (Docker 必須) / LadybugDB (WAL バグで頓挫) を試したが、研究者が個人 PC で完結できる構成を諦められず **専用グラフDB `aira-graphdb` を Rust でゼロから開発**
> - **HotpotQA 500問で Str-Acc 89.4% / LLM-Acc 91.2%** を達成。論文 GPT-4o-mini 71.6% に対し **+19.6pt**
> - 日本語版にも GINZA 統合で対応し、**LLM-Acc 70.8%**（Neo4j baseline 58.5% から +12.3pt）

:::note info
#### こんな研究者・エンジニアに読んでほしい
- 学術論文の山に埋もれている知見を、根拠付きで横断検索したい
- Microsoft GraphRAG を試したが Factoid QA 精度に不満がある
- MemGraphRAG 論文を読んだが Python 実装が自分のワークフローに合わない
- Neo4j を本番運用したくない（Docker / JVM / ライセンス）
- TypeScript / Rust 製の自前 RAG スタックに興味がある
:::

---

# 1. なぜ Classic RAG では学術論文に勝てないのか

学術論文を対象にした RAG は、一般的な FAQ や社内ドキュメント検索とは性質が大きく異なる。

| 課題 | 具体例 | Classic RAG の挙動 |
|------|--------|-------------------|
| **マルチホップ推論** | 「PPR を使った GraphRAG で最も精度が高い手法は？」 | ❌ 単一チャンクで答えが完結しない |
| **エンティティの同一性** | "PPR" = "Personalized PageRank" = "Topic-Sensitive PageRank" | ❌ 別物として索引化される |
| **矛盾するファクト** | 論文A「手法Xは95%」vs 論文B「手法Xは80%」 | ❌ 矛盾を検出できない |
| **長い推論連鎖** | 「Aの提唱者が所属していた研究室の系譜」 | ❌ チャンク跨ぎの関係が落ちる |
| **専門用語の同義語** | "TF-IDF" ↔ "term frequency–inverse document frequency" | ❌ 表記揺れで取り逃す |

Classic RAG（埋め込みベクトル + top-k 検索 + LLM 生成）は、**「1つの文書に答えが書かれている」場合**には十分機能する。しかし学術論文の知識統合では、**複数論文・複数チャンクをまたいだ関係性** が本質である。ベクトル類似度だけでは、関係グラフが失われている。

:::note info
#### Factoid QA とは
「誰が／いつ／どこで」を1つ答える質問応答タスク。
学術文脈では「この酵素を発見した研究者は？」「実験で使われたデータセットは？」など。
要約ではなく **正確な1つの答え** が要るため、検索精度が直接スコアに反映される。
:::

論文 [HotpotQA](https://hotpotqa.github.io/) はこのマルチホップ Factoid QA の代表的ベンチマークで、**2ホップ以上の推論を強制する** ように作られている。Classic RAG は HotpotQA で 50% 台に届かないことが多い。

---

# 2. Graph RAG が必要な理由

Graph RAG は、テキストから **エンティティと関係を抽出してナレッジグラフ化** し、検索時にグラフ構造を活かす。

```
Classic RAG:
  Query → Embedding → Vector top-k → Chunks → LLM → Answer

Graph RAG:
  Query → Entity/Vector → Graph traversal (PPR / community) → Context → LLM → Answer
```

ナレッジグラフを導入すると以下が解決する:

| 問題 | グラフが効く理由 |
|------|----------------|
| マルチホップ推論 | エッジを辿って n-hop 先のエンティティに到達可能 |
| エンティティ同一性 | 表記揺れを正規化して同一ノードにマージ |
| 矛盾の可視化 | 同じエンティティに紐づく複数の Fact を並べて比較できる |
| 関係性検索 | 「A の弟子の弟子」のようなパターンマッチが可能 |

ただし、Graph RAG の実装は一様ではない。代表的な系譜を見ていく。

---

# 3. 既存 Graph RAG の比較

## 3.1 Microsoft GraphRAG — コミュニティ要約型

[Microsoft GraphRAG](https://arxiv.org/abs/2404.16130) (Edge et al., 2024) は **Leiden アルゴリズムでコミュニティ検出** → 各コミュニティを LLM で要約 → クエリ時に Map-Reduce する。

```
Chunking → Entity Extraction → Community Detection (Leiden)
       → Per-community LLM Summary → Query: Map-Reduce of summaries
```

- ✅ **グローバルクエリに強い**（「このコーパスの主要テーマは？」）
- ❌ **インデックスコストが高い**（全コミュニティに LLM 要約）
- ❌ **Factoid QA に弱い**（要約レベルでしか答えられない）
- ❌ **品質管理機構がない**（低レベル抽出ミスが要約に伝播）

HotpotQA Str-Acc は **51.6%**（[筆者の検証](https://qiita.com/hisaho/items/40b3042371067322ea81)）。
論文 MemGraphRAG も以下を指摘:

> *"Despite its utility in summarizing high-level themes, this unsupervised approach faces limitations regarding precision, as inaccuracies in low-level entity relationships can propagate upward."*

## 3.2 LazyGraphRAG — 遅延評価型

[LazyGraphRAG](https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/) (Microsoft Research, 2024) は、インデックス時のコストを **1/100** に削減する遅延評価戦略。

- ✅ コスト効率が極めて高い
- ❌ クエリ時の LLM 呼び出しが増える
- ❌ 構造化ナレッジグラフを構築しない（あくまで軽量 NLP）

## 3.3 MemGraphRAG — メモリベース＋マルチエージェント

[KDD 2026 論文 MemGraphRAG](https://arxiv.org/abs/2606.00610) (Xiang et al.) は、コミュニティ検出を捨て、**三層グローバルメモリ** と **マルチエージェント協調** でグラフ品質を底上げする。

```
Chunking
  ↓ Stage I: Extraction Agent
Three-Layer Memory (Ontology / Fact / Passage)
  ↓ Stage II: Schema Stabilization (頻度閾値 τ)
  ↓ Stage III: Conflict Detection & Resolution
  ↓ Stage IV: Graph Projection
Hierarchical Indexing Graph
  ↓ PPR (Personalized PageRank, λ=0.5)
Query Response
```

論文の主張する仕組みは以下:

| 仕組み | 解決する問題 |
|--------|-------------|
| 三層メモリ（Ontology / Fact / Passage） | 抽象度の異なる検索を1つのバックエンドで |
| スキーマ安定化 (τ=2) | 低頻度・ノイズスキーマの除去 |
| 矛盾検出/解決 | 同一エンティティの相反するファクトを検出 |
| PPR（テレポート λ=0.5） | クエリ起点からのグラフ拡散ベース検索 |

報告された HotpotQA 精度は **GPT-4o-mini で Str-Acc 67.2% / LLM-Acc 71.6%**。
これは Microsoft GraphRAG (51.6%) と比べて十分高いが、論文実装は **Python + NetworkX** で、MCP 統合も日本語対応もない。

## 3.4 比較表

| 特性 | MS-GraphRAG | LazyGraphRAG | MemGraphRAG (論文) | **aira-synapse (本記事)** |
|------|:-----------:|:------------:|:-----------------:|:--------------------------:|
| 言語 | Python | Python | Python | **TypeScript + Rust** |
| グラフ構築 | Community-based | NLP-only | Memory-based agents | **Memory-based agents** |
| メモリ層 | なし | なし | 3層 | **3層 + 辞書/シソーラス** |
| スキーマ安定化 | × | × | ✓ | ✓ |
| 矛盾検出 | × | × | ✓ | ✓ |
| PPR | × | × | ✓ | ✓ (hub 抑制付き) |
| ハイブリッド検索 | × | × | × | **✓ (Vector + BM25 RRF)** |
| グラフ DB | FAISS | — | NetworkX | **aira-graphdb (Rust)** |
| 日本語 | × | × | × | **✓ (GINZA)** |
| HotpotQA Str-Acc | 51.6% | 52.7% | 67.2% | **89.4%** |
| HotpotQA LLM-Acc | — | — | 71.6% | **91.2%** |

---

# 4. aira-synapse が目指したもの

aira-synapse は MemGraphRAG 論文のアルゴリズムを **TypeScript で完全クリーンルーム実装** したライブラリ + MCP サーバーである。

設計の根本にあるのは以下3つ:

## 4.1 再現性 — 論文の主張を独立検証する

論文の精度を鵜呑みにせず、ゼロから実装して同条件で検証する。aira-synapse の実装で確認できたのは:

- 三層メモリ・スキーマ安定化・矛盾検出・PPR は **すべて精度に寄与する**
- 一方、サブクエリ分解は LLM の非決定性で **bridge 問題が不安定**になる
- 専門用語辞書をテレポートベクトルに注入すると **-3.4% の退行** が出ることもある（ablation で判明）
- 最大の改善は論文に書かれていない **eval 関数の改善** と **Vector+BM25 ハイブリッド**

## 4.2 拡張性 — 日本語論文・専門分野に対応する

論文の公式実装は英語前提。日本の研究者が使うには:

- 日本語形態素解析（GINZA / spaCy）が必須
- 文境界・トークン推定・NER をすべて言語固有にしなければならない
- カタカナ表記揺れ（「コンピュータ」「コンピューター」）の正規化が要る

aira-synapse は Python sidecar 経由で GINZA を呼び出し、**チャンキング・NER・トークン推定の全てを日本語専用パイプライン** に切り替えられる設計とした。

## 4.3 実用性 — 研究者個人の PC で完結する

Microsoft GraphRAG や論文実装は **クラウド前提** または **重い依存（Docker / JVM）** を要求する。研究者が自分のラップトップで「論文 PDF を放り込んで質問する」を完結させたい。

これが後述の **専用グラフDB `aira-graphdb`** を作る動機になった。

## 4.4 aira-synapse 独自の拡張

論文にない機能を3つ追加している:

| 拡張 | 内容 |
|------|------|
| **DictionaryBoost** | 専門用語辞書による NER ブースト（PPR → Personalized PageRank 等の略語展開） |
| **ThesaurusNormalization** | 同義語/上位語/下位語によるスキーマ統合 |
| **HybridMemoryFilter** | Vector + BM25 Reciprocal Rank Fusion (RRF) |

特に最後の **Hybrid RRF** は HotpotQA Bridge 問題で **+1.8pt** の改善を出した（後述）。

---

# 5. グラフ DB の選定 — なぜ Neo4j / LadybugDB を諦めて Rust で自作したか

aira-synapse の心臓部は「ナレッジグラフを永続化・検索するグラフ DB」である。
ここに何を使うかが、システム全体の運用性と精度の両方を決める。

筆者は順に3つを試した。

## 5.1 第1案: Neo4j — 精度は出る、しかし運用が重い

最初の実装では **Neo4j Community 5.26** を採用。Cypher が書きやすく、HotpotQA でも **88.4% (Str-Acc, 442/500)** という最初の高スコアを出した。

しかし運用面で限界があった:

| 課題 | 詳細 |
|------|------|
| **Docker / JVM 必須** | 研究者の個人 PC で起動・終了の負担が大きい |
| **ライセンス** | Enterprise 版機能を将来的に使えない |
| **単一ファイル化できない** | バックアップ・配布が複雑 |
| **メモリ消費** | ヒープ調整がシビア、6GB DB で起動が遅い |

> **結論**: 精度は出るが、「研究者が論文 PDF を放り込んで質問する」というユースケースには重すぎる。

## 5.2 第2案: LadybugDB — 軽量だが WAL バグでブロック

次に試したのが [LadybugDB](https://github.com/agnesoft/ladybug)（Rust製の組み込みグラフDB）。単一バイナリ・組み込み型・Cypher サポートと条件は揃っていた。

しかし実環境で **WAL（Write-Ahead Log）のリカバリーに致命的バグ** があり、500問規模のベンチマークで永続化したデータの読み戻しに失敗。修正待ちで止まるわけにいかず断念。

## 5.3 第3案: aira-graphdb をゼロから Rust で開発

「組み込み・単一ファイル・高速・自分でメンテできる」を全部満たすには、**自作するしかない** という結論に達した。

### 5.3.1 aira-graphdb のアーキテクチャ

```
┌──────────────────────────────────────────────────────┐
│ hotpotqa.agdb (JSON) + hotpotqa.vblob (binary)       │
├──────────────────────────────────────────────────────┤
│ nodes: 206K (entity / concept / passage / schema)    │
│ edges: 448K (relations, transitions)                 │
│ vectors: 98K (passage 7.8K + fact 87K + schema 3.2K) │
│ memory: facts 113K + passages 10K + schemas 3.8K     │
│ passages: 10K (FTS index)                            │
╘══════════════════════════════════════════════════════╛
        ↕ JSON-RPC over stdin/stdout
┌──────────────────────────────────────────────────────┐
│ aira-graphdb-native (Rust release binary)            │
│ - Domain RPCs (get_nodes / get_adjacent / ...)       │
│ - Vector search: brute-force cosine (f64 SIMD)       │
│ - HNSW index (v0.3.0)                                │
│ - Cypher engine (MATCH/RETURN/relationship filter)   │
│ - Persistence: vblob + WAL + atomic rename           │
└──────────────────────────────────────────────────────┘
```

### 5.3.2 設計判断

| 判断 | 理由 |
|------|------|
| **JSON-RPC over stdin/stdout** | TS から Rust バイナリを sidecar で起動するだけ。ネットワーク不要 |
| **単一 `.agdb` + `.vblob`** | バックアップは2ファイルコピー。Docker 不要 |
| **ドメイン固有 RPC を維持** | `get_adjacent` 等はインデックス済みで O(1)。Cypher より速い |
| **Cypher は補助** | アドホックなパターンマッチング用にだけ提供 |
| **f64 vector + SIMD** | 98K ベクトルなら brute-force でも数 ms |
| **HNSW (v0.3.0)** | 大規模化に備えて段階的に有効化 |
| **vblob 分離 (v0.3.0)** | ベクトルを外部バイナリに分離して DB サイズを1/3に削減 |

### 5.3.3 自作で良かったこと

- **精度バグを自分で直せる**: フィールド名の不一致 (`vector` vs `values`) で全ベクトルがゼロベクトル化されていた重大バグを発見・修正できた（後述）
- **RPC を任意に追加できる**: `memory_save_file` のような独自 RPC を必要に応じて生やせる
- **永続化フォーマットを制御できる**: vblob / WAL / 増分 persist など最適化が自由
- **依存ゼロでバンドル可能**: 研究者は `npm install` だけで使える

---

# 6. HotpotQA 最終ベンチマーク結果

500問の HotpotQA で、Neo4j baseline からどう改善が積み上がったかを示す。

## 6.1 改善の積み上げ（英語版）

| # | バージョン | Str-Acc | LLM-Acc | 改善 | 主な変更 |
|---|-----------|---------|---------|------|---------|
| 1 | Neo4j baseline | 88.4% | — | — | 基準値 |
| 2 | aira-graphdb 初期 | 55% | — | — | ID ミスマッチ |
| 3 | ID 修正 | 64.8% | — | +9.8 | バッチベース ID 統一 |
| 4 | スコアリング修正 | 84.6% | — | +19.8 | normalizedContains |
| 5 | v0.3.0 + ベクトル補完 | 84.6% | — | ±0 | 全 namespace sync |
| 6 | eval関数統一 | 87.4% | — | +2.8 | Rules 5-9 追加 |
| 7 | Answer matcher 15種 | 88.8% | — | +1.4 | 数詞変換等 |
| 8 | Entity dedup | 89.0% | — | +0.2 | "the_X"→"X" マージ |
| 9 | **Hybrid RRF** | **89.4%** | — | +0.4 | **Vector+BM25 fusion** |
| 10 | **LLM-Acc 評価** | 89.4% | **91.2%** | — | LLM Judge 導入 |

## 6.2 効いた改善の中身

### Vector + BM25 RRF (Bridge +1.8pt)

ベクトル検索と BM25 を並列実行し、Reciprocal Rank Fusion で統合:

$$\text{RRF}(d) = \sum_{r \in R} \frac{1}{K + r(d)}, \quad K = 60$$

- **Vector**: 意味的類似度（"米国" → "アメリカ" も拾える）
- **BM25**: 固有名詞・年号の exact match（"1958年" を確実に取れる）
- **BM25-only 結果は係数 0.7 で減衰**（過信を防ぐ）

### Entity Deduplication

`"the_X"` → `"X"` パターン (238 ペア) を 80K エンティティから検出してマージ。
1,271 エッジをリダイレクトし、Bridge +0.8pt。

### eval 関数統一（最大の罠）

Pure-agdb が低く見えていた 18 件の失敗のうち、**13 件はベースラインと完全に同じ回答** を返していた。原因は eval 関数の差:

| ルール | 効果 |
|--------|------|
| 5: ニックネーム展開 | Rosie ↔ Roseann |
| 6: ステム F1 (60%) | 長い gold answer |
| 7: 国名エイリアス | USA / United States |
| 8: デモニム ↔ 国名 | Northern Irish ↔ Northern Ireland |
| 9: 姓名マッチング | John Lasseter ↔ John Alan Lasseter |

> 教訓: **異なる eval 関数で比較すると 3pt 以上の偽の精度差** が生じる。バックエンド比較の前に eval を統一せよ。

## 6.3 LLM-Acc で回収された9問

Str-Acc 89.4% から LLM Judge (GPT-5.4-mini) で **+1.8pt → 91.2%** に到達。

| Gold Answer | LLM 回答 | 回収理由 |
|-------------|---------|---------|
| novelist | writer | 同義語 |
| Lord Byron | George Gordon Byron, 6th Baron Byron | 正式名 |
| Scottish Premiership club Hearts | Heart of Midlothian | 略称↔正式名 |
| international football competition | FIFA Women's World Cup | 上位概念↔具体例 |
| TOGO company | Kabushiki-gaisha Tōgo | 日英表記 |
| Vivendi S.A. | Universal Music Group | 親会社↔子会社 |
| ... | ... | ... |

## 6.4 論文との比較

| 手法 | LLM | Str-Acc | LLM-Acc |
|------|-----|---------|---------|
| MemGraphRAG 論文 | GPT-4o-mini | 67.2% | 71.6% |
| **aira-synapse + aira-graphdb** | **GPT-5.4-mini** | **89.4%** | **91.2%** |
| 差分 | — | **+22.2pt** | **+19.6pt** |

LLM が新しい（GPT-5.4-mini）こと、Hybrid RRF など独自改善が効いていること、eval 関数を統一していること等の総合効果。

## 6.5 日本語版

英語版の知見を日本語にも適用:

| バージョン | Str-Acc | LLM-Acc | 主な変更 |
|-----------|---------|---------|---------|
| LadybugDB + Neo4j baseline | 58.5% | — | 基準値 |
| aira-graphdb + GINZA 文分割 | 64.3% | — | 形態素ベースのチャンキング |
| v2 (4 施策統合) | 70.8% | — | tokenize + entity expand + dedup + matcher |
| v3 (JA 強制プロンプト) | 67.3% | — | ❌ -3.5pt 棄却 |
| **v2 + LLM-Acc** | **70.8%** | **70.8%** | 21問回収 |
| v3 DB (76K facts, 密度3.4倍) | 71.0% | — | +0.2pt（誤差範囲） |
| v3 + o4-mini | ~64.5% | — | ❌ gpt-5.4-miniより-6.3pt |

英語と日本語で **チャンキング戦略を別物に作り直した** ことが鍵。日本語は GINZA の sentencizer + 文字数×0.5 でのトークン推定が必須で、英語と同じ `\n\n` 分割を流用すると 1 段落 2,000–5,000 文字の巨大チャンクができてしまう。

## 6.6 JA 精度改善の徹底検証

日本語 70.8% を超えるため、以下を全て試行した:

| 施策 | 効果 | 理由 |
|------|------|------|
| Fact密度3.4倍 (22K→76K) | +0.2pt | 検索失敗は4%のみ、情報量は問題ではない |
| 英語推論プロンプト | -5.1pt | 日本語質問→英語推論の切替でロス発生 |
| o4-mini (推論特化モデル) | -6.3pt | gpt-5.4-miniより日本語処理が弱い |
| JA回答強制プロンプト | -3.5pt | 固有名詞のカタカナ誤変換が増加 |
| JA優先コンテキスト並替 | 逆効果 | 重要な英語Factが後方に押しやられた |
| topK増加 | -1.3pt | ノイズ増加でLLM判断阻害 |
| 2-hop embedding | 無効 | 89%パッセージ重複、ベクトル不動 |

**7施策全てが効果なしまたは逆効果**。失敗116問の分析で、96%が「具体的だが誤り」（LLM推論エラー）、検索失敗は4%のみであることが判明した。

## 6.7 EN vs JA ギャップの根本原因

| 指標 | EN | JA | Gap |
|------|-----|-----|-----|
| **Overall** | 89.4% | 71.0% | **18.4pt** |
| Bridge | 89.3% | 68.5% | **20.8pt** |
| Comparison | 90.0% | 80.2% | **9.8pt** |

ギャップの支配的要因は **Bridge問題の20.8pt差**:

1. **日英混在コーパスでの推論チェーン断絶** — JA コーパス（日本語 Wikipedia）にも英語固有名詞が多数混在し、エンティティ A → 関連情報 → エンティティ B の推論チェーンが切れる
2. **LLM の日本語推論力の限界** — GPT-5.4-mini は英語の訓練データ量が圧倒的に多く、日英混在コンテキストからの多段推論で精度が低下
3. **コーパス品質の差** — EN は英語 Wikipedia オリジナル（エンティティ表記が統一）、JA は翻訳記事が多く表記揺れが大きい（ヴィ/ビ、ー/長音省略等）
4. **評価の厳しさ** — カタカナ変換の揺れで取りこぼしが発生し、LLM Judge でも回収不能（応答自体が別エンティティ）

**結論**: JA 70.8% は現アーキテクチャ（single-shot RAG + gpt-5.4-mini）の実質的上限。これはコーパスの構造的問題と LLM の日本語推論力の限界に起因し、アーキテクチャ変更では解決困難である。

---

# 7. 最終構成

```
┌───────────────────────────────────────────────────────────┐
│ HotpotQA Benchmark Results                                │
│   EN: Str-Acc 89.4% (447/500), LLM-Acc 91.2% (456/500)   │
│   JA: Str-Acc 70.8% (283/400), LLM-Acc 70.8% (283/400)   │
│   Bridge:  EN 89.3% / JA 68.5% (Gap: 20.8pt)             │
│   Compare: EN 90.0% / JA 80.2% (Gap: 9.8pt)              │
├───────────────────────────────────────────────────────────┤
│ LLM: GPT-5.4-mini (reasoning_effort=high, verbosity=low)  │
│ Retrieval: HybridMemoryFilter (Vector + BM25 RRF, K=60)   │
│ Graph: AiraGraphDbGraphProjection (206K nodes, 448K edges)│
│ Vector: AiraGraphDbVectorIndex (98K vectors, f64)         │
│ Memory: AiraGraphDbMemoryStore (113K facts, 10K passages) │
│ Dict/Thesaurus: SQLite                                    │
│ HyperParams: hub=50, topK=10, topM=10, ctx=3000           │
│ Backend: Pure aira-graphdb (.agdb + .vblob, 単一プロセス)  │
│ Paper baseline: EN Str-Acc 67.2%, LLM-Acc 71.6%           │
│ vs Paper: EN +22.2pt (Str-Acc), +19.6pt (LLM-Acc)         │
└───────────────────────────────────────────────────────────┘
```

研究者の個人 PC で:

1. 論文 PDF を Dockling で Markdown 化
2. `aira-synapse index` でナレッジグラフに投入
3. MCP 経由で Claude Desktop / VS Code Copilot から自然言語で質問
4. 根拠パッセージ付き回答が返る

これが Docker なし・JVM なし・単一バイナリ + 2ファイルの DB で動く。

---

# 8. まとめ

- 学術論文 RAG では Classic RAG（ベクトル + top-k）は **マルチホップ・エンティティ同一性・矛盾検出** で力不足
- Microsoft GraphRAG はグローバル要約に強いが、Factoid QA では 51.6% にとどまる
- MemGraphRAG (KDD 2026) の三層メモリ + マルチエージェントは方向性として正しい
- これを TypeScript でクリーンルーム実装したのが **aira-synapse**
- グラフ DB は Neo4j (運用重い) → LadybugDB (WAL バグ) → **aira-graphdb を Rust で自作** に至った
- 結果: HotpotQA **Str-Acc 89.4% / LLM-Acc 91.2%**（論文 +19.6pt 改善）
- 日本語版も GINZA 統合で LLM-Acc 70.8%（Neo4j baseline +12.3pt）
- JA は7つの改善策を徹底検証し、70.8% が現アーキテクチャの上限であることを実験的に確認

**得られた知見**:

1. グラフ品質を上げる最大の打ち手は「コミュニティ検出」ではなく **メモリベースの抽出 + スキーマ安定化**
2. Vector と BM25 は **相補的**。RRF で統合すると Bridge +1.8pt
3. ベンチマークで重要なのは **eval 関数の統一**。バックエンドより eval で 3pt 動く
4. 多言語対応は **チャンキング層から作り直す** 必要がある
5. 研究者の手元で動く RAG を作るには、**DB を含めて自作する覚悟** が要る
6. Fact密度を3.4倍にしても精度は+0.2pt。**検索品質ではなくLLM推論力が天井**
7. 日英ギャップの主因は **Bridge問題での推論チェーン断絶**（コーパスの日英混在＋LLMの日本語推論力の限界）

aira-synapse / aira-graphdb のソースは順次公開予定。コードベースの構造や ADR は [`docs/aira-graphdb-accuracy-journey.md`](https://github.com/nahisaho/aira-synapse) を参照。

---

## 参考文献

- Edge et al., 2024. *From Local to Global: A Graph RAG Approach to Query-Focused Summarization*. [arXiv:2404.16130](https://arxiv.org/abs/2404.16130)
- Xiang et al., 2026. *MemGraphRAG: Memory-based Multi-Agent System for Graph Retrieval-Augmented Generation*. KDD 2026. [arXiv:2606.00610](https://arxiv.org/abs/2606.00610)
- Yang et al., 2018. *HotpotQA: A Dataset for Diverse, Explainable Multi-hop Question Answering*. [hotpotqa.github.io](https://hotpotqa.github.io/)
- Microsoft Research, 2024. *LazyGraphRAG: Setting a New Standard for Quality and Cost*.
