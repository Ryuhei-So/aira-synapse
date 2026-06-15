# PLAN-MEMGRAPHRAG-003: クエリ精度改善 実装計画

| フィールド | 値 |
|-----------|---|
| **ID** | PLAN-MEMGRAPHRAG-003 |
| **バージョン** | 1.0 |
| **ステータス** | Draft |
| **作成日** | 2026-06-15 |
| **対応要件** | REQ-MEMGRAPHRAG-003 v1.3 |
| **対応設計** | DES-MEMGRAPHRAG-003 v1.5 |
| **パッケージ** | `@nahisaho/memgraphrag` |

## 1. 実装フェーズ概要

全 20 タスク、4 フェーズ。各タスクはテストファースト（Red → Green → Blue）で実装する。

| フェーズ | タスク数 | 見積もり | 内容 |
|---------|--------|---------|------|
| P1: 基盤 | 5 | 3h | フラグ、型定義、マイグレーション、共有ユーティリティ |
| P2: インデキシング | 3 | 4h | LexiconBuilder、パイプライン統合、CLI |
| P3: クエリ強化 | 8 | 8h | 辞書注入、シソーラス拡張、エイリアスヒント、SubQuery、CV、メトリクス、QueryService統合 |
| P4: 検証 | 4 | 3h | ベンチマーク更新、バックフィル実行、アブレーション、v15回帰 |
| **合計** | **20** | **18h** | |

## 2. タスク一覧

### Phase 1: 基盤（依存なし）

#### T-001: QueryFeatureFlags 型定義

- **ファイル**: `src/domain/config/featureFlags.ts`（新規）
- **DES**: DES-MG3-009
- **内容**:
  - `QueryFeatureFlags`, `EvalFeatureFlags`, `IndexingFeatureFlags` インターフェース定義
  - `DEFAULT_QUERY_FLAGS`, `DEFAULT_EVAL_FLAGS` 定数
- **テスト**: 型テスト（デフォルト値の検証）
- **見積もり**: 30min

#### T-002: lexicon_evidence マイグレーション

- **ファイル**: `src/infrastructure/storage/migrations/0004_add_lexicon_evidence.sql`（新規）
- **DES**: DES-MG3-001
- **内容**:
  - `lexicon_evidence` テーブル作成（corpus_id FK CASCADE、surface_form 含む UNIQUE 制約）
  - インデックス作成（corpus_id+document_id, corpus_id+entity_normalized）
  - `SchemaVersionManager` でのバージョン登録
- **テスト**: マイグレーション適用 → テーブル存在確認 → UNIQUE 制約検証
- **見積もり**: 30min

#### T-003: ContextBundle メタデータ拡張

- **ファイル**: `src/domain/retrieval/ppr.ts`（変更）
- **DES**: DES-MG3-013
- **内容**:
  - `ContextBundle` に `metadata?: { aliasHintCount?: number }` 追加（後方互換）
- **テスト**: 既存テスト通過確認（metadata なしでも動作）
- **見積もり**: 15min

#### T-004: NodeInitializationVector 拡張

- **ファイル**: `src/domain/retrieval/memoryFilter.ts`（変更）
- **DES**: DES-MG3-013
- **内容**:
  - `NodeInitializationVector` に `injectedCount?: number` 追加
- **テスト**: 既存テスト通過確認
- **見積もり**: 15min

#### T-005: query-utils 共有ユーティリティ

- **ファイル**: `src/application/query/query-utils.ts`（新規）
- **DES**: DES-MG3-014
- **内容**:
  - `extractFinalAnswer()` を `DefaultQueryService` から抽出・移動
  - `isComparisonQuery()` ヘルパー（既存ロジック抽出）
  - `escapeRegex()` ユーティリティ
  - `withTimeout<T>(promise, ms): Promise<T | null>` ヘルパー
- **テスト**: 各関数の単体テスト（extractFinalAnswer の既存テストケース移行）
- **見積もり**: 45min

### Phase 2: インデキシング（P1 完了後）

#### T-006: LexiconBuilder 実装

- **ファイル**: `src/application/indexing/LexiconBuilder.ts`（新規）
- **DES**: DES-MG3-001, DES-MG3-002
- **依存**: T-001, T-002
- **内容**:
  - `LexiconBuilder` クラス（constructor: ITermDictionary, Database, corpusId）
  - `buildIncremental(documentId, facts, passages)` — エンティティ解決アルゴリズム Step 1-5
  - `backfill()` — 全コーパス再構築
  - トランザクショナル再インデックスフロー（旧 evidence 取得 → 削除 → 新挿入 → 再計算 → 曖昧性評価）
  - `term_id = lex:${corpusId}:${entityNormalized}` 生成
  - `occurrence_count` による頻度追跡
  - `canonical_form` = 最高頻度 surface_form
  - 同格構文パターン検出（also known as, a.k.a., 括弧内）
  - Jaccard ≥ 0.8 + 共出現 ≥ 2 によるエイリアス検出
  - 曖昧性除外（複数 entityId に紐づく surfaceForm）
  - stopword 除外（頻度上位 1%）
- **テスト**:
  - 空ドキュメント → 空結果
  - 基本的なエンティティ抽出 + 頻度カウント
  - エイリアス検出（同格構文、括弧内、Jaccard）
  - 曖昧性除外
  - 冪等性（同一 documentId 再実行で結果同一）
  - 消滅エンティティ削除（ドキュメント更新で旧エンティティが消えた場合）
  - シソーラス関係生成（synonym, hypernym）
  - corpus-scoped term_id 一意性
- **見積もり**: 2h

#### T-007: FullDocumentIndexingPipeline Stage V 統合

- **ファイル**: `src/application/indexing/FullDocumentIndexingPipeline.ts`（変更）
- **DES**: DES-MG3-001
- **依存**: T-006
- **内容**:
  - `FullPipelineOptions` に `enableDictionaryIndexing` + `lexiconBuilderFactory` 追加
  - `processDocument()` 末尾に Stage V 呼び出し
  - 早期リターンパスでも Stage V cleanup 実行（buildIncremental(docId, [], [])）
- **テスト**:
  - フラグ ON: Stage V が実行される
  - フラグ OFF: Stage V がスキップされる
  - 早期リターン時のクリーンアップ
- **見積もり**: 1h

#### T-008: lexiconCommand CLI

- **ファイル**: `src/interface/cli/lexiconCommand.ts`（新規）、`src/interface/cli/index.ts`（変更）、`src/interface/index.ts`（変更）
- **DES**: DES-MG3-010a
- **依存**: T-006
- **内容**:
  - `registerLexiconCommand(program)` — `lexicon build <corpusId>`
  - `LexiconBuilder.backfill()` の呼び出し
  - 結果サマリー表示
  - `src/interface/cli/index.ts` にインポート・登録追加
  - `src/interface/index.ts` にエクスポート追加
- **テスト**: CLI 引数パース検証
- **見積もり**: 30min

### Phase 3: クエリ強化（P1 完了後、P2 と並行可能な部分あり）

#### T-009: SQLiteLexiconStore トークン境界マッチング

- **ファイル**: `src/infrastructure/storage/SQLiteLexiconStore.ts`（変更）
- **DES**: DES-MG3-003
- **依存**: T-005（escapeRegex）
- **内容**:
  - `match()` メソッドを `\b` ワード境界正規表現に変更
  - `DictionaryMatch` に `matchedText` フィールド追加（longest-match ソート用）
- **テスト**:
  - トークン境界一致（"Byron" は "Lord Byron" にマッチ、"ron" は非マッチ）
  - マルチワードフレーズ一致
  - matchedText が正しく設定される
- **見積もり**: 45min

#### T-010: DictionaryAwareNodeInitializer

- **ファイル**: `src/application/query/DictionaryAwareNodeInitializer.ts`（新規）
- **DES**: DES-MG3-003
- **依存**: T-001, T-004, T-005
- **内容**:
  - `INodeInitializer` Decorator 実装
  - フラグ OFF → inner 委譲
  - 辞書マッチ → ファクト注入（max 10/entity, 30/total）
  - confidence < 0.5 スキップ
  - inactive ファクト除外
  - スコア: maxBaseScore × 0.3（正のベクトルスコアなし時は 1.0 × 0.3）
  - L1 正規化
  - `injectedCount` 返却
- **テスト**:
  - フラグ OFF → inner と同一結果
  - 辞書マッチなし → inner と同一結果
  - 基本注入（1 エンティティ、3 ファクト）
  - per-entity 上限（10）
  - total 上限（30）
  - confidence フィルタ
  - inactive ファクト除外
  - L1 正規化後の合計 = 1.0
  - ベクトルスコア 0 時のフォールバック
- **見積もり**: 1.5h

#### T-011: ThesaurusExpansionPolicy フレーズマッチ拡張

- **ファイル**: `src/application/query/ThesaurusExpansionPolicy.ts`（変更）
- **DES**: DES-MG3-004
- **依存**: T-009（matchedText）
- **内容**:
  - コンストラクタに `ITermDictionary` 追加
  - Phase 1: 辞書ベースフレーズマッチ（`[...matches].sort()` by matchedText.length）
  - Phase 2: `getRelations()` + relationType フィルタ（findSynonyms/findHypernyms 不使用）
  - `hypernymLimit` フラグ連動
  - 重複排除
- **テスト**:
  - マルチワードエイリアス展開（"Lord Byron" → "George Gordon Byron"）
  - 単語単位シノニム展開
  - hypernym フラグ制御
  - 重複排除
  - longest-match 優先
- **見積もり**: 1h

#### T-012: AliasAwareContextBuilder

- **ファイル**: `src/application/query/AliasAwareContextBuilder.ts`（新規）
- **DES**: DES-MG3-005
- **依存**: T-001, T-003
- **内容**:
  - `IContextBuilder` Decorator 実装
  - フラグ OFF → inner 委譲
  - エンティティ抽出 → 辞書マッチ → ヒントセクション構築
  - Greedy トークンバジェットチェック（10% 上限）
  - `metadata.aliasHintCount` 全リターンパスで設定
- **テスト**:
  - フラグ OFF → inner と同一結果（metadata.aliasHintCount = undefined）
  - ヒントなし → aliasHintCount = 0
  - 基本ヒント追加
  - 10% バジェット超過 → トリム
  - バジェット 0 → ヒントなし
  - 既存 citedPassages/citedFacts/confidence が維持される
- **見積もり**: 1h

#### T-013: SubQueryDecomposer

- **ファイル**: `src/application/query/SubQueryDecomposer.ts`（新規）
- **DES**: DES-MG3-007, DES-MG3-008
- **依存**: T-005（withTimeout, isComparisonQuery）
- **内容**:
  - `isBridgeCandidate(text)` — isComparison=false + BRIDGE_PATTERNS
  - `decompose(request)` — 逐次 2-hop
  - 全ステップ deadline チェック + withTimeout ラップ
  - hop-1 LLM 生成 → hop-1 検索 → ブリッジ抽出 → hop-2 生成 → hop-2 検索
  - `DecompositionResult` with hop1/hop2Candidates
  - 5 フォールバック条件
  - `mergeCandidates()` — 重み付きマージ（0.4/0.3/0.3）
- **テスト**:
  - isBridgeCandidate: comparison=false + パターンマッチ
  - isBridgeCandidate: comparison=true → false
  - hop-1 タイムアウト → fallback
  - hop-1 結果なし → fallback
  - ブリッジ抽出失敗 → fallback
  - hop-2 タイムアウト → fallback
  - 全体タイムアウト → fallback
  - 正常系 2-hop マージ
  - マージ重み検証
- **見積もり**: 2h

#### T-014: ComparisonVerifier

- **ファイル**: `src/application/query/ComparisonVerifier.ts`（新規）
- **DES**: DES-MG3-014
- **依存**: T-005（extractFinalAnswer）
- **内容**:
  - `verify(initialAnswer, rawResponse, query, context, hyperParams)`
  - `hasExplicitComparison(response)` — 両エンティティの属性検出
  - 初回検証 OK → verified=true
  - 再生成 1 回 → 成功なら再生成回答、失敗なら initialAnswer
  - LLM エラー時 → initialAnswer, verified=false
- **テスト**:
  - 明示的比較あり → verified=true, 初回回答
  - 明示的比較なし + 再生成成功 → verified=true, 再生成回答
  - 明示的比較なし + 再生成失敗 → verified=false, 初回回答
  - LLM エラー → verified=false, 初回回答
- **見積もり**: 1h

#### T-015: QueryMetrics 拡張

- **ファイル**: `src/application/query/QueryService.ts`（変更）
- **DES**: DES-MG3-013
- **依存**: T-004
- **内容**:
  - `QueryMetrics` に新規フィールド追加
  - メトリクス組み立てコード追加
- **テスト**: メトリクスフィールドの存在確認
- **見積もり**: 30min

#### T-016: QueryService フラグ統合 + Decorator 組み立て

- **ファイル**: `src/application/query/QueryService.ts`（変更）、`src/interface/runtime/MemGraphRagRuntime.ts`（変更）
- **DES**: DES-MG3-003, 004, 007, 009, 014
- **依存**: T-010, T-011, T-012, T-013, T-014, T-015
- **内容**:
  - `QueryServiceDependencies` に `featureFlags?` 追加
  - `query()` にフラグ分岐挿入（辞書マッチ、展開、SubQuery、CV）
  - v15 後方互換: 全フラグ OFF → 辞書/シソーラス非参照
  - `MemGraphRagRuntime` で Decorator チェーン組み立て
  - `MemGraphRagRuntime.getLexiconStats(corpusId)` — 辞書/シソーラスの行数取得
  - `MemGraphRagRuntime.lexiconBackfill(corpusId)` — `LexiconBuilder.backfill()` ラッパー
  - `lexiconBuilderFactory` 注入
  - `ThesaurusExpansionPolicy` コンストラクタに `ITermDictionary` 追加
- **テスト**:
  - 全フラグ OFF → 既存と同一の動作
  - 各フラグ個別 ON/OFF
  - Decorator チェーンの正しい組み立て
- **見積もり**: 1.5h

### Phase 4: 検証（P2, P3 完了後）

#### T-017: ベンチマークスクリプト更新

- **ファイル**: `scripts/benchmark-hotpotqa-ladybug.mjs`（変更）、`scripts/benchmark-hotpotqa.mjs`（変更）
- **DES**: DES-MG3-006, 011, 012
- **依存**: T-016
- **内容**:
  - `aliasNormalizedContains()` 関数追加
  - アブレーション CLI フラグ（`--no-dictionary-injection` 等 + `--v15-baseline`）
  - フラグから `QueryFeatureFlags` / `EvalFeatureFlags` 構築
  - プリフライト辞書チェック + 自動バックフィル
  - per-question JSON に `evalAliasNormalized`, `evalOriginalCorrect`, `evalNormalizedCorrect` 追加
  - アブレーション出力 JSON（delta, questionsFlipped）
- **テスト**:
  - CLI フラグパース検証（各フラグが正しい FeatureFlags に変換される）
  - `aliasNormalizedContains()` 単体テスト:
    - 通常一致（エイリアスなし）
    - 対称エイリアス展開（response にエイリアス、gold に正式名 → true）
    - 曖昧エイリアス除外（マッチしない）
    - 既存正解が正規化で不正解にならない
  - プリフライトバックフィル呼び出し検証
- **見積もり**: 1.5h

#### T-018: HotpotQA コーパスバックフィル実行

- **DES**: DES-MG3-010a
- **依存**: T-006, T-007, T-008
- **内容**:
  - 既存 HotpotQA コーパスに対して `memgraphrag lexicon build <corpusId>` 実行
  - 辞書エントリ数・シソーラス関係数を確認
- **見積もり**: 30min（実行時間は別）

#### T-019: フルベンチマーク実行

- **DES**: DES-MG3-011
- **依存**: T-017, T-018
- **内容**:
  - 全フラグ ON ベンチマーク（v16-full）
  - プロダクト精度ゲート（v16-product, --no-eval-alias）
  - 精度 ≥ 87.6% 確認
  - per-question レイテンシ記録、avg/p95 算出（REQ-MG3-010: avg < 5s, p95 < 10s）
- **見積もり**: 30min（実行時間は別、約 60-90min）

#### T-020: アブレーション + v15 回帰検証

- **DES**: DES-MG3-011, DES-MG3-012
- **依存**: T-019
- **内容**:
  - 個別フラグ OFF × 5 アブレーション実行
  - 各アブレーション精度 ≥ 85% 確認
  - `--v15-baseline` 実行、精度 87.6% 確認
  - response 一致率レポート（診断情報）
- **見積もり**: 30min（実行時間は別、約 5-7h）

## 3. 依存関係図

```
Phase 1 (並行可能):
  T-001 ──┬──→ T-010, T-012, T-016
  T-002 ──┼──→ T-006
  T-003 ──┼──→ T-012
  T-004 ──┼──→ T-010, T-015
  T-005 ──┼──→ T-009, T-010, T-013, T-014

Phase 2 (T-001, T-002 完了後):
  T-006 ──┬──→ T-007, T-008, T-018
  T-007 ──┤
  T-008 ──┴──→ T-018

Phase 3 (T-005 完了後、P2 と並行可能):
  T-009 ──→ T-011
  T-010 ──┐
  T-011 ──┤
  T-012 ──┼──→ T-016
  T-013 ──┤
  T-014 ──┤
  T-015 ──┘

Phase 4 (P2, P3 完了後):
  T-016 ──→ T-017 ──→ T-019 ──→ T-020
  T-018 ──→ T-019
```

## 4. リスク

| リスク | 影響 | 対策 |
|--------|------|------|
| LexiconBuilder のエイリアス検出精度が不十分 | 辞書利用率が低いまま | Jaccard 閾値を調整可能に（config パラメータ化） |
| 2-hop SubQuery の LLM コスト増加 | ベンチマーク実行時間・コスト増 | gpt-5.4-mini 限定、タイムアウト制御 |
| v15 回帰（フラグ全 OFF で精度変動） | LLM 非決定性による偽陽性 | 3 回実行の中央値で判定 |
| マイグレーション互換性 | 既存 DB との互換 | CREATE TABLE IF NOT EXISTS + 既存データ非破壊 |

## 5. 品質ゲート

- [ ] 全タスクのテストが通過（`npm test`）
- [ ] ビルド成功（`npm run build`）
- [ ] フルベンチマーク精度 ≥ 87.6%（プロダクト精度）
- [ ] 平均クエリレイテンシ < 5s、p95 < 10s（REQ-MG3-010）
- [ ] 個別アブレーション精度 ≥ 85%
- [ ] v15 baseline 精度 = 87.6%
- [ ] 辞書エントリ数 > 0（バックフィル後）

## 6. トレーサビリティ

| タスク | REQ | DES |
|--------|-----|-----|
| T-001 | MG3-009 | DES-MG3-009 |
| T-002 | MG3-001 | DES-MG3-001 |
| T-003 | MG3-013 | DES-MG3-013 |
| T-004 | MG3-013 | DES-MG3-013 |
| T-005 | MG3-014 | DES-MG3-014 |
| T-006 | MG3-001, 002 | DES-MG3-001, 002 |
| T-007 | MG3-001 | DES-MG3-001 |
| T-008 | MG3-010a | DES-MG3-010a |
| T-009 | MG3-003 | DES-MG3-003 |
| T-010 | MG3-003 | DES-MG3-003 |
| T-011 | MG3-004 | DES-MG3-004 |
| T-012 | MG3-005 | DES-MG3-005 |
| T-013 | MG3-007, 008 | DES-MG3-007, 008 |
| T-014 | MG3-014 | DES-MG3-014 |
| T-015 | MG3-013 | DES-MG3-013 |
| T-016 | MG3-003, 004, 007, 009, 010, 012, 014 | DES-MG3-003, 004, 007, 009, 012, 014 |
| T-017 | MG3-006, 011, 012 | DES-MG3-006, 011, 012 |
| T-018 | MG3-010a | DES-MG3-010a |
| T-019 | MG3-010, 011 | DES-MG3-010, 011 |
| T-020 | MG3-011, 012 | DES-MG3-011, 012 |
