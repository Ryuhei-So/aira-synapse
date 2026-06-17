# REQ-MEMGRAPHRAG-004: クエリ精度改善 Phase 2（診断・クエリリライト・パッセージ再ランキング・比較クエリ改善）

| フィールド | 値 |
|-----------|---|
| **ID** | REQ-MEMGRAPHRAG-004 |
| **バージョン** | 1.2 |
| **ステータス** | Draft |
| **作成日** | 2026-06-18 |
| **更新日** | 2026-06-18 |
| **パッケージ** | `@nahisaho/memgraphrag` |
| **レビュー** | Rubber-duck review ×2 反映済み（v1.0 → v1.1 → v1.2） |

## 1. 背景と動機

### 1.1 現在の達成状況

v15 eval v2 で HotpotQA 500 問ベンチマークにおいて **90.0%**（450/500）を達成した。論文公式実装（71.6%）を +18.4% 上回るが、**残り 50 問のエラー** に改善余地がある。

### 1.2 エラー分析結果（eval v2 適用後）

500 問中 50 問の不正解を分類した結果：

| カテゴリ | 件数 | 説明 | 回復可能性 |
|---------|:----:|------|:---------:|
| **完全不正解（検索失敗）** | 14 | 間違ったエンティティ/ファクトを取得 | 要診断（Oracle Recall） |
| **表現の違い（未回復）** | 18 | eval v2 で回復できなかった表現差異 | Eval 改善 or 回答正規化 |
| **汎用的すぎる正解** | 5 | gold が "IT", "yes" 等 | 限定的 |
| **Yes/No 誤判定** | 3 | Comparison で論理判断ミス | 比較クエリ改善 |
| **スペル違い** | 1 | 1年の誤差 (1937 vs 1938) | 対処不可 |
| *eval v2 で回復済み* | *8* | *fuzzy/synonym/geo で回復* | *対応済み* |
| **回復可能合計** | **40** | スペル違い 1 件を除く | — |

**重要な発見:**
- 全 50 問で正解テキストはコーパスに存在（コーパスギャップ = 0 件）
- 14 件の完全不正解は純粋な検索失敗（正しいパッセージにたどり着けない）
- 検索メトリクス（PPR iter=3.9, passages=10, tokens=~1695）は正解/不正解で同一
- v0.3.0 ablation で辞書/シソーラスの PPR 注入は逆効果と判明（-3.4%）
- HP チューニング（topK=20, topM=20, ctx=5000）は効果なし（88.0% vs 88.4%）
- **HP チューニングが効かなかった事実は、PPR top-K にそもそも正解パッセージが含まれていない可能性を示唆する**

### 1.3 改善戦略

**Phase 0（診断）→ Phase 1（低リスク改善）→ Phase 2（高リスク改善）** の段階的アプローチを採用する。

| フェーズ | アプローチ | 対象エラー | 前提条件 |
|---------|-----------|:---------:|---------|
| **Phase 0: 診断** | Oracle Recall@K 測定 | 14 件（検索失敗） | なし |
| **Phase 1a: 比較クエリ改善** | Yes/No 判定プロンプト強化 | 3 件（Yes/No） | なし |
| **Phase 1b: 回答正規化** | LLM 出力の正規化指示 | 18 件（表現差異） | なし |
| **Phase 2a: クエリリライト** | マルチホップ分解 | 14 件（検索失敗） | Phase 0 の結果次第 |
| **Phase 2b: パッセージ再ランキング** | LLM ベース再順位付け | 14 件（検索失敗） | Oracle Recall@20 > 50% |

**注意:** Phase 2a/2b は同じ 14 件を対象とする。期待回復数は **合計で 14 件中 5-8 件**（+1.0-1.6%）であり、加算はしない。

## 2. 要件

### 2.0 成功基準

#### REQ-MG4-000: 目標精度

**種別**: UBIQUITOUS
**優先度**: P0

**要件**:
THE system SHALL achieve a HotpotQA 500-question accuracy of at least **91.6%** (≥458/500) under the approved Phase 2 feature configuration, representing a recovery of at least 8 of the 40 recoverable errors.

**受入基準**:
- [ ] 500 問ベンチマークで 458 問以上正解（≥91.6%）を達成
- [ ] 既知 50 問のエラーのうち、少なくとも 8 問が回復
- [ ] 既知 450 問の正解のうち、退行は 3 問以内
- [ ] 上記が 2 回の独立実行で再現可能

**トレーサビリティ**: DES-MEMGRAPHRAG-004
**パッケージ**: `@nahisaho/memgraphrag`

### 2.1 Phase 0: Oracle Recall 診断

#### REQ-MG4-001: Oracle Recall@K 測定

**種別**: EVENT-DRIVEN
**優先度**: P0

**要件**:
WHEN Phase 2 implementation begins, THE system SHALL first measure oracle passage recall at K=10, 20, and 50 for the 50 known error cases, determining how many errors have the gold-supporting passage (identified by HotpotQA supporting fact title match) within the PPR candidate set.

**Oracle Recall の定義:**
- 判定基準: HotpotQA `supporting_facts` のタイトルに一致するパッセージが PPR top-K に含まれるか
- 各エラーは2つの supporting fact を持つため、「両方を含む (strict)」「少なくとも1つを含む (lenient)」の2指標を報告
- gold answer の文字列含有は **補助指標** として併記するが、ゲート判定には使用しない（"yes"/"IT" 等の汎用回答による偽陽性を防止）

**受入基準**:
- [ ] 50 問の既知エラーそれぞれについて、supporting fact パッセージが PPR top-K (K=10,20,50) に含まれるか判定
- [ ] Recall@10, Recall@20, Recall@50 をカテゴリ別（検索失敗/表現差異/Yes-No/汎用/スペル違い）に報告（strict/lenient 両方）
- [ ] 診断結果に基づき、以下の判定を行う（14 件の検索失敗カテゴリに対する lenient recall で評価）：
  - Recall@20 > 50%（8+/14）→ 再ランキング実装に進む
  - Recall@20 < 50% → 再ランキングはスキップし、クエリリライトに集中
  - Recall@50 ≤ 30% → PPR 自体の到達性に問題があり、根本的な検索戦略変更が必要
- [ ] 診断結果が `data/benchmark/hotpotqa/oracle_recall_report.json` に保存

**トレーサビリティ**: DES-MEMGRAPHRAG-004
**パッケージ**: `@nahisaho/memgraphrag`

#### REQ-MG4-002: 既知エラー追跡セット

**種別**: UBIQUITOUS
**優先度**: P0

**要件**:
THE system SHALL maintain a tracked set of the 50 known error question IDs with their categories, and all benchmark runs SHALL report recovery/regression counts by category against this set.

**受入基準**:
- [ ] 50 問のエラー ID・カテゴリが `data/benchmark/hotpotqa/known_errors_v15.json` に保存
- [ ] ベンチマークスクリプトが既知エラーセットを読み込み、カテゴリ別の回復/退行を報告
- [ ] レポート形式: `recovered: {retrieval: N, expression: N, yesno: N, generic: N, spelling: N}, regressed: {from_correct: N}`
- [ ] 450 問の正解セットからの退行数も報告

**トレーサビリティ**: DES-MEMGRAPHRAG-004
**パッケージ**: `@nahisaho/memgraphrag`

### 2.2 Phase 1a: 比較クエリ改善

#### REQ-MG4-003: Yes/No 比較クエリの判定強化

**種別**: EVENT-DRIVEN
**優先度**: P1

**要件**:
WHEN a comparison query expecting a yes/no answer is detected, THE system SHALL retrieve evidence for both compared entities and produce a structured reasoning chain before outputting the final yes/no answer.

**検出基準:**
- **Yes/No 回答期待クエリ**: "Are both X and Y...", "Is it true that...", "Did X and Y both..." — 回答が yes/no であることが文法的に明確なもの
- **比較クエリ（非 Yes/No）**: "Which is more...", "Who is taller..." — 回答がエンティティ名であるもの。これは REQ-MG4-005 のクエリリライト対象であり、本要件の対象外
- **検出パターン**: `^(are|is|do|does|did|was|were|have|has|had|can|could|will|would|should)\b` で始まるクエリ + 2つ以上のエンティティ参照

**受入基準**:
- [ ] Yes/No 回答期待の比較クエリを上記検出パターンで分類できる
- [ ] 両エンティティについて個別にパッセージを取得
- [ ] LLM プロンプトに「両方の証拠を比較し、結論を述べよ」の指示を含む
- [ ] 既知 3 件の Yes/No エラーのうち、少なくとも 2 件が回復
- [ ] フィーチャーフラグ `enableComparisonReasoning` で制御可能

**トレーサビリティ**: DES-MEMGRAPHRAG-004
**パッケージ**: `@nahisaho/memgraphrag`

### 2.3 Phase 1b: 回答正規化

#### REQ-MG4-004: LLM 回答の正規化指示

**種別**: EVENT-DRIVEN
**優先度**: P1

**要件**:
WHEN generating the final answer, THE system SHALL instruct the LLM to prefer canonical forms (full names, official titles, standard abbreviations) to reduce expression mismatches with gold answers.

**受入基準**:
- [ ] QA プロンプトに正規化指示を追加（「公式名称・正式名称を使用せよ」等）
- [ ] 表現差異 18 件のうち、少なくとも 3 件が回復
- [ ] 既存の正解 450 問に対して退行が 0 件
- [ ] フィーチャーフラグ `enableAnswerNormalization` で制御可能

**トレーサビリティ**: DES-MEMGRAPHRAG-004
**パッケージ**: `@nahisaho/memgraphrag`

### 2.4 Phase 2a: クエリリライト

#### REQ-MG4-005: マルチホップクエリ分解

**種別**: EVENT-DRIVEN
**優先度**: P1

**要件**:
WHEN a bridge-type multi-hop query is received, THE system SHALL decompose it into a sequence of sub-queries using the LLM, execute each sub-query against the graph, and use the combined results to build the final context.

**分解戦略（仕様）:**

1. **検出**: bridge タイプのクエリを検出（comparison は対象外、REQ-MG4-003 で処理）
2. **分解**: LLM に1回の呼び出しで、以下の JSON スキーマに従ってサブクエリを生成させる：
   ```json
   {
     "sub_queries": [
       {"step": 1, "query": "...", "purpose": "find intermediate entity"},
       {"step": 2, "query": "...", "depends_on": 1, "purpose": "find final answer using step 1 result"}
     ]
   }
   ```
3. **実行**: step 1 のサブクエリで PPR を実行し、上位パッセージから中間回答を LLM で抽出
4. **結合**: 中間回答を step 2 のクエリに埋め込み、再度 PPR を実行
5. **統合**: 両ステップのパッセージを統合して最終コンテキストを構築
6. **バリデーション**: JSON パースエラー、空サブクエリ、step 数 > 3 の場合はフォールバック

**受入基準**:
- [ ] bridge クエリを2つのサブクエリに分解できる
- [ ] 出力 JSON スキーマのバリデーションが行われる
- [ ] 中間回答を step 2 に埋め込んで2段階検索を実行できる
- [ ] 分解の LLM 呼び出しは 1 回、中間回答抽出は 1 回（計 2 回追加）
- [ ] フィーチャーフラグ `enableQueryRewriting` で制御可能

**トレーサビリティ**: DES-MEMGRAPHRAG-004
**パッケージ**: `@nahisaho/memgraphrag`

#### REQ-MG4-006: クエリリライトのフォールバック

**種別**: UNWANTED
**優先度**: P0

**要件**:
THE system SHALL NOT fail or degrade when query rewriting produces malformed sub-queries; it SHALL fall back to the original query and record the fallback event.

**受入基準**:
- [ ] JSON パースエラー、空サブクエリ、タイムアウト（5s）時にフォールバック
- [ ] フォールバック時に元のクエリで通常の検索パイプラインを実行
- [ ] `queryRewriteFallback: true` がメトリクスに記録される
- [ ] Graceful Degradation パターンに準拠

**トレーサビリティ**: DES-MEMGRAPHRAG-004
**パッケージ**: `@nahisaho/memgraphrag`

### 2.5 Phase 2b: パッセージ再ランキング

#### REQ-MG4-007: PPR 後のパッセージ再ランキング

**種別**: EVENT-DRIVEN
**優先度**: P1
**前提条件**: REQ-MG4-001（Oracle Recall 診断）で Recall@20 > 50%（8+/14）が確認されていること

**要件**:
WHEN PPR retrieves the top-K passages and oracle recall diagnostic confirms sufficient candidate coverage (Recall@20 > 50%), THE system SHALL re-rank the top-20 passages using LLM-based relevance scoring, selecting the top-10 for context building.

**受入基準**:
- [ ] PPR top-20 パッセージに対して LLM で関連度スコアリング（1 バッチ呼び出し）
- [ ] スコア順に上位 10 を選択してコンテキスト構築
- [ ] 再ランキングの有無はフィーチャーフラグ `enablePassageReranking` で制御可能
- [ ] `IPassageReranker` インターフェースが Domain 層に定義（初期実装は `LLMPassageReranker` のみ）
- [ ] 再ランキングのトークン消費・レイテンシがメトリクスに記録

**トレーサビリティ**: DES-MEMGRAPHRAG-004
**パッケージ**: `@nahisaho/memgraphrag`

### 2.6 フィーチャーフラグ統合

#### REQ-MG4-008: Phase 2 フィーチャーフラグ

**種別**: UBIQUITOUS
**優先度**: P0

**要件**:
THE system SHALL define Phase 2 query feature flags in the `QueryFeatureFlags` interface, with all flags defaulting to OFF (opt-in). A promoted configuration SHALL be explicitly defined after ablation testing confirms accuracy improvement.

**受入基準**:
- [ ] `enableQueryRewriting: boolean` が `QueryFeatureFlags` に追加（default: false）
- [ ] `enablePassageReranking: boolean` が追加（default: false）
- [ ] `enableComparisonReasoning: boolean` が追加（default: false）
- [ ] `enableAnswerNormalization: boolean` が追加（default: false）
- [ ] 各フラグは独立して有効/無効を切り替え可能
- [ ] 環境変数（`QUERY_REWRITE=true` 等）でオーバーライド可能
- [ ] ablation 後の推奨構成を `PROMOTED_QUERY_FLAGS` として定義

**トレーサビリティ**: DES-MEMGRAPHRAG-004
**パッケージ**: `@nahisaho/memgraphrag`

### 2.7 ベンチマーク検証

#### REQ-MG4-009: ベンチマークプロトコル

**種別**: EVENT-DRIVEN
**優先度**: P0

**要件**:
WHEN any Phase 2 feature is evaluated, THE system SHALL follow a reproducible benchmark protocol with statistical rigor.

**ベンチマークプロトコル:**
1. データセット: HotpotQA 500 問（固定、ハッシュ検証）
2. モデル: GPT-5.4-mini, reasoning_effort=high, verbosity=low
3. 再現性: 同一条件での 2 回実行で ±0.5% 以内の差
4. 報告: 全体精度 + カテゴリ別（bridge/comparison）+ 既知エラー回復/退行

**受入基準**:
- [ ] 各機能を個別に ON にした 500 問結果が記録されている
- [ ] 推奨構成での 500 問結果が 2 回実行で再現されている
- [ ] 既知 50 問エラーのカテゴリ別回復/退行が報告されている
- [ ] 既知 450 問正解からの退行数が報告されている
- [ ] 結果が `data/benchmark/hotpotqa/` に JSON 形式で保存

**トレーサビリティ**: DES-MEMGRAPHRAG-004
**パッケージ**: `@nahisaho/memgraphrag`

#### REQ-MG4-010: 精度非劣化保証

**種別**: UNWANTED
**優先度**: P0

**要件**:
THE system SHALL NOT degrade the HotpotQA 500-question accuracy below 89.5% (baseline 90.0% minus 0.5% statistical tolerance) when any individual Phase 2 feature is enabled. Features that cause regression beyond this threshold SHALL be disabled.

**受入基準**:
- [ ] 各機能単独で 89.5% 未満にならないことが 500 問で検証
- [ ] regression が検出された機能は `DEFAULT_QUERY_FLAGS` で false に設定
- [ ] ablation 結果が `spec/` に文書化

**トレーサビリティ**: DES-MEMGRAPHRAG-004
**パッケージ**: `@nahisaho/memgraphrag`

## 3. 非機能要件

### REQ-MG4-NFR-001: レイテンシ制約

**種別**: STATE-DRIVEN
**優先度**: P1

**要件**:
WHILE all Phase 2 features are enabled, THE system SHALL maintain an average query latency of less than 10 seconds per query (≈2.5x the current 3.8s baseline).

**受入基準**:
- [ ] クエリリライト: +3s 以内（LLM 分解 + 中間回答抽出）
- [ ] 再ランキング: +2s 以内（LLM バッチスコアリング）
- [ ] 比較推論: +1s 以内（プロンプト変更のみ）
- [ ] 合計平均レイテンシ < 10s/query

### REQ-MG4-NFR-002: API コスト制約

**種別**: STATE-DRIVEN
**優先度**: P1

**要件**:
WHILE all Phase 2 features are enabled, THE system SHALL not exceed 4x the LLM API cost per query compared to the baseline.

**受入基準**:
- [ ] baseline: 1 LLM call/query（回答生成）
- [ ] Phase 2 最大: 4 LLM calls/query（分解 + 中間回答 + 再ランキング + 回答生成）
- [ ] 各機能の LLM トークン消費がメトリクスに記録

### REQ-MG4-NFR-003: 観測可能性メトリクス

**種別**: UBIQUITOUS
**優先度**: P1

**要件**:
THE system SHALL record detailed retrieval quality metrics for each query to enable post-hoc analysis of accuracy changes.

**受入基準**:
- [ ] `subQueryCount`: 分解されたサブクエリ数（0 = 未分解）
- [ ] `subQueryParseSuccess`: サブクエリ JSON パース成功/失敗
- [ ] `rerankScoreRange`: 再ランキングスコアの最大/最小/中央値
- [ ] `rerankPositionChange`: 再ランキング前後の順位変動数
- [ ] `comparisonDetected`: 比較クエリとして検出されたか
- [ ] `queryRewriteFallback`: フォールバック発生フラグ

## 4. 制約と前提

### 4.1 制約

1. v0.3.0 ablation の教訓：**PPR teleport vector への外部ノード注入は避ける**。v1.0 にあった PPR seed 品質改善（REQ-MG4-006/007）は v1.1 で削除した。クエリリライトは seed 注入ではなく、**クエリ自体を改善** するアプローチ
2. 100 問テストは ±3% のブレがあるため、**最終判断は 500 問 × 2 回実行** で行う
3. LLM モデルは GPT-5.4-mini を使用（reasoning_effort + verbosity 制御）
4. LadybugDB のシングルライターロック制約に留意
5. **Phase 2b（再ランキング）は Oracle Recall 診断の結果次第** で実装判断

### 4.2 前提

1. v15 eval v2 baseline（90.0%）が安定して再現可能であること
2. HotpotQA 1,000 問コーパスが完全にインデックス化済みであること
3. LadybugDB + SQLite の二重ストレージ構成が維持されること

## 5. 変更履歴

### v1.1 → v1.2 変更点（Rubber-duck review #2 反映）

| 指摘 | 対応 |
|------|------|
| Oracle Recall を gold answer 文字列含有で判定すると偽陽性 | supporting fact タイトル一致に変更、strict/lenient 2指標、文字列含有は補助指標に降格 |
| Recall@20 閾値 ">50%" と "7+/14" が矛盾 | `>50%（8+/14）` に統一 |
| 91.5% = 457.5問で曖昧 | `≥458/500（91.6%+）` に明確化 |
| known-error カテゴリが不完全 | レポートに `generic`, `spelling` を追加 |
| Yes/No 検出が broad すぎ | Yes/No 期待と比較クエリ（非Yes/No）を分離、検出パターンを正式定義 |

### v1.0 → v1.1 変更点（Rubber-duck review #1 反映）

| 指摘 | 対応 |
|------|------|
| 目標精度の欠如 | REQ-MG4-000（91.5% 目標）を追加 |
| 期待効果の二重計上 | 3機能の対象エラーが重複する旨を明記。合計 5-8 件回復と修正 |
| 再ランキングの前提未検証 | Phase 0（Oracle Recall 診断）を必須前提条件として追加 |
| クエリリライトの仕様不足 | 分解戦略・JSON スキーマ・中間回答結合・バリデーションを詳細化 |
| Yes/No 誤判定が放置 | REQ-MG4-003（比較クエリ改善）を新設 |
| 表現差異 18 件が未対応 | REQ-MG4-004（回答正規化）を新設 |
| 非劣化基準が統計的に脆弱 | ±0.5% の統計的許容範囲を明記、2 回実行による再現性を要求 |
| PPR seed ブーストが v0.3.0 と同パターン | PPR seed 改善要件を削除。クエリリライトに集中 |
| IPassageReranker の過剰設計 | 初期実装は LLMPassageReranker のみに限定 |
| 既知エラー追跡がない | REQ-MG4-002（エラー追跡セット）を新設 |
| 観測可能性メトリクスがない | REQ-MG4-NFR-003 を新設 |

## 6. 用語定義

| 用語 | 定義 |
|------|------|
| **クエリリライト** | LLM を用いてマルチホップクエリを複数のシングルホップサブクエリに分解する手法 |
| **パッセージ再ランキング** | PPR で取得したパッセージ群を、クエリとの関連性に基づいて再順位付けする手法 |
| **Oracle Recall@K** | HotpotQA supporting fact タイトルに一致するパッセージが PPR の上位 K 件に含まれる割合（理想的な再ランキングの上限を示す） |
| **PPR seed** | Personalized PageRank のテレポートベクトル（初期確率分布） |
| **Ablation テスト** | 各機能を個別に ON/OFF して効果を測定する手法 |
| **eval v2** | fuzzyMatch, synonymMatch, geoContainmentMatch, acronymMatchImproved を含む評価ロジック |
| **推奨構成 (PROMOTED)** | Ablation 後に精度改善が確認された機能の組み合わせ |

## 7. 要件一覧

| ID | タイトル | 種別 | 優先度 | フェーズ |
|----|---------|------|:------:|:-------:|
| REQ-MG4-000 | 目標精度（≥458/500, 91.6%+） | UBIQUITOUS | P0 | — |
| REQ-MG4-001 | Oracle Recall@K 測定 | EVENT-DRIVEN | P0 | Phase 0 |
| REQ-MG4-002 | 既知エラー追跡セット | UBIQUITOUS | P0 | Phase 0 |
| REQ-MG4-003 | Yes/No 比較クエリ改善 | EVENT-DRIVEN | P1 | Phase 1a |
| REQ-MG4-004 | LLM 回答正規化 | EVENT-DRIVEN | P1 | Phase 1b |
| REQ-MG4-005 | マルチホップクエリ分解 | EVENT-DRIVEN | P1 | Phase 2a |
| REQ-MG4-006 | クエリリライトのフォールバック | UNWANTED | P0 | Phase 2a |
| REQ-MG4-007 | パッセージ再ランキング | EVENT-DRIVEN | P1 | Phase 2b |
| REQ-MG4-008 | Phase 2 フィーチャーフラグ | UBIQUITOUS | P0 | — |
| REQ-MG4-009 | ベンチマークプロトコル | EVENT-DRIVEN | P0 | — |
| REQ-MG4-010 | 精度非劣化保証 | UNWANTED | P0 | — |
| REQ-MG4-NFR-001 | レイテンシ制約（<10s） | STATE-DRIVEN | P1 | — |
| REQ-MG4-NFR-002 | API コスト制約（4x以内） | STATE-DRIVEN | P1 | — |
| REQ-MG4-NFR-003 | 観測可能性メトリクス | UBIQUITOUS | P1 | — |
