# REQ-MEMGRAPHRAG-003: クエリ精度改善（辞書活用・エイリアス解決・2-hop サブクエリ）

| フィールド | 値 |
|-----------|---|
| **ID** | REQ-MEMGRAPHRAG-003 |
| **バージョン** | 1.3 |
| **ステータス** | Draft |
| **作成日** | 2026-06-15 |
| **更新日** | 2026-06-15 |
| **パッケージ** | `@nahisaho/memgraphrag` |
| **レビュー** | Rubber-duck review ×3 反映済み（v1.0 → v1.1 → v1.2 → v1.3） |

## 1. 背景と動機

v15 ベンチマーク（HotpotQA 500 問、LadybugDB バックエンド）で **87.6%**（438/500）の精度を達成したが、62 件の誤答分析から以下の改善余地が判明した：

| カテゴリ | 件数 | 説明 |
|---------|------|------|
| 情報ギャップ | 48 | 正しいパッセージを取得できず、完全に別のエンティティを回答 |
| エイリアス/粒度 | 12 | 正解と部分的に重複（"Lord Byron" vs "George Gordon Byron, 6th Baron Byron"） |
| Yes/No 反転 | 2 | Comparison 問題で逆の判定 |

特筆すべきは、**辞書・シソーラスの利用率が 0%**（`dictionaryMatchCount=0`, `expandedTerms=[]` が全 500 問）であること。
原因は `term_dictionary` / `thesaurus_relations` テーブルが完全に空であり、インデキシングパイプラインが辞書構築を行っていないためである。

### バックエンド間比較

| 指標 | SQLite (v14) | LadybugDB (v15) |
|------|-------------|-----------------|
| 両方で誤答 | — | 54 件（永続的問題） |
| SQLite のみ誤答 | 30 件 | — |
| LadybugDB のみ誤答 | — | 8 件（退行） |

## 2. 要件

### 2.1 辞書自動構築（インデキシング時）

**REQ-MG3-001**: WHEN a corpus is indexed, THE system SHALL automatically populate the term dictionary from extracted entities, building entries with canonical forms, zero or more aliases, and domain categories.

エンティティ解決ルール:
- **正規エンティティID**: ファクトトリプルの head/tail 文字列を小文字正規化し、同一文字列を同一エンティティとして扱う
- **エイリアスリンク**: 以下のいずれかを満たす場合にのみエイリアスとして紐付ける:
  (a) 同一パッセージ内で同格構文（"X, also known as Y" / "X (Y)" / "X, or Y"）として出現
  (b) 同一パッセージ内で同一 NER タイプ + トークン Jaccard ≥ 0.8 + 共出現パッセージ ≥ 2
  ※ ファクトトリプルの head/tail 共出現のみではエイリアスと判定しない（通常は関連エンティティであり同一エンティティではないため）
- **正規形選択**: 最高頻度の表記を canonical_form とする
- **曖昧エイリアス**: 複数の異なるエンティティ ID に紐づく表記はエイリアスとして登録しない。この除外は辞書構築・シソーラス synonym 生成・クエリ展開・プロンプトヒント・評価正規化の全てに適用される
- **コーパススコープ**: 全辞書エントリは `corpus_id` でスコープされ、他コーパスと隔離される

- 受入基準:
  - [ ] インデキシング完了後、`term_dictionary` テーブルにエントリが存在する
  - [ ] 各エントリに `canonical_form` が設定されている（エイリアスは観測された表記揺れがある場合のみ）
  - [ ] エンティティの出現頻度（`frequency`）が正しくカウントされている
  - [ ] 既存インデキシングパイプライン（Stage I〜IV）の後に Stage V として追加される
  - [ ] 再インデキシング時は既存エントリを冪等に更新する（頻度の再計算を含む）
  - [ ] コーパス削除時に関連辞書エントリも削除される
  - [ ] 全ルックアップ操作は `corpus_id` でフィルタされる

**REQ-MG3-002**: WHEN a corpus is indexed, THE system SHALL automatically populate thesaurus relations from alias patterns and entity type signals, using the following rules:

- **synonym**: 同一エンティティの表記揺れ（例: "Lord Byron" ↔ "George Gordon Byron, 6th Baron Byron"）。判定基準: REQ-MG3-001 のエイリアスリンクルール (a)(b) を満たすペアのみ。文字列類似度のみでは不十分（候補生成にのみ使用）
- **hypernym**: 明示的な同格構文パターン（"X, a Y"）または信頼度の高い NER タイプ情報から生成。共起のみでは不十分
- co-occurrence のみの弱い証拠は関係生成に使用しない

- 受入基準:
  - [ ] インデキシング完了後、`thesaurus_relations` テーブルに関係が存在する
  - [ ] synonym 関係はエイリアスリンクルール (a)(b) を満たす場合のみ生成される
  - [ ] 関係の信頼度（`confidence`）は根拠の強さに基づいて算出される（共起頻度のみではない）
  - [ ] 高頻度汎用語（stopword 的エンティティ）は関係生成から除外される（頻度上位 1% のエンティティ）
  - [ ] 全シソーラスエントリは `corpus_id` でスコープされる
  - [ ] コーパス削除時に関連シソーラスエントリも削除される

### 2.2 辞書の検索パイプライン統合

**REQ-MG3-003**: WHEN a query contains terms matching dictionary entries, THE system SHALL inject additional candidate facts/passages containing the matched canonical/alias entities into the PPR seed vector, independently of vector search results.

注入ルール:
- **候補検索**: `corpus_id` スコープ内で、マッチしたエンティティを head または tail に含むファクトを検索する
- **上限**: エンティティあたり最大 10 件、クエリあたり最大 30 件の注入ファクト
- **マッチング**: トークン境界を考慮した完全一致（部分文字列マッチは不可）
- **曖昧性除外**: 辞書エントリの `confidence < 0.5` の場合は注入をスキップ
- **スコア計算**: `injectedScore = baseScore × 0.3`。`baseScore` はベクトル検索シードの最大スコアの値（range: 0.0〜1.0）。注入ファクトのスコアは常にベクトル検索結果より低くなる
- **注入対象**: fact ノードのみ（passage/schema ノードは注入しない）
- **マージ**: ベクトル検索シードと注入シードを結合後、L1 正規化

- 受入基準:
  - [ ] 辞書マッチしたエンティティを含むファクトが、ベクトル検索結果に存在しない場合でも PPR シードに注入される
  - [ ] 注入候補数がエンティティあたり 10 件、クエリあたり 30 件を超えない
  - [ ] PPR シードベクトルは注入後に L1 正規化される
  - [ ] `dictionaryMatchCount` / `dictionaryInjectedCount` メトリクスが記録される
  - [ ] 辞書が空の場合は注入なし（現行動作と同一）

**REQ-MG3-004**: WHEN a query is expanded via thesaurus, THE system SHALL append synonym/hypernym terms to the embedding query for broader vector retrieval.

- 受入基準:
  - [ ] `expandedTerms` メトリクスに展開された用語が記録される
  - [ ] 展開クエリによるベクトル検索で追加の関連パッセージが取得される
  - [ ] 展開上限（synonym: 3, hypernym: 2）が維持される
  - [ ] 曖昧なエイリアス（複数エンティティに紐づく用語）は展開から除外される
  - [ ] hypernym 展開はデフォルト無効（`enableHypernymExpansion` フラグで制御）。synonym 展開のみデフォルト有効

### 2.3 エイリアス解決

**REQ-MG3-005**: WHEN building the LLM prompt context, THE system SHALL include entity alias hints for key entities mentioned in the context passages (e.g., "X is also known as Y").

- 受入基準:
  - [ ] プロンプトにエイリアス情報が含まれる
  - [ ] エイリアスヒントはコンテキストトークン制限内に収まる
  - [ ] ヒント追加によるトークン使用量の増加が 10% 以内
  - [ ] 曖昧なエイリアス（複数エンティティに紐づく）はヒントから除外される

**REQ-MG3-006**: (ベンチマーク評価ハーネス) WHEN evaluating answers, the benchmark harness SHALL apply entity alias normalization from the dictionary before `normalizedContains` comparison.

- 受入基準:
  - [ ] "George Gordon Byron, 6th Baron Byron" → "Lord Byron" のような正規化が行われる
  - [ ] 正規化マップはインデキシング時に構築された辞書エントリから自動生成される
  - [ ] 正規化により既存の正解が不正解にならない（false negative 防止）
  - [ ] 曖昧なエイリアス（1:N マッピング）は正規化から除外される
  - [ ] これはベンチマーク評価の改善であり、プロダクトの回答品質とは独立して計測される
  - [ ] 正規化は対称的に適用される（予測と gold の両方をエイリアス等価集合に変換してから比較）

### 2.4 LLM ベース 2-hop サブクエリ生成

**REQ-MG3-007**: WHEN a bridge-type question is detected, THE system SHALL decompose the question into a sequential 2-hop retrieval: (1) generate hop-1 sub-query via LLM, (2) retrieve passages for hop-1, (3) extract bridge entity from hop-1 results, (4) generate hop-2 sub-query incorporating the bridge entity, (5) retrieve passages for hop-2, (6) merge both result sets before PPR ranking.

詳細仕様:
- **Bridge 検出**: `isComparisonQuery()` が false かつ、質問文にエンティティ参照の連鎖パターンが含まれる場合（例: "the director of the film that..."）。ベンチマークラベル `type` は使用しない
- **LLM 出力スキーマ**: `{ hop1Query: string, expectedBridgeType: string }` — 構造化 JSON 出力を要求
- **ブリッジエンティティ抽出**: hop-1 検索結果の上位パッセージから抽出。LLM の幻覚ではなく、検索済みエビデンス内に存在するエンティティのみ使用
- **ブリッジ信頼度**: 抽出されたエンティティが `expectedBridgeType` と一致し、hop-1 上位 3 パッセージのいずれかに出現する場合のみ hop-2 に進む
- **ブリッジ候補数**: 最大 3 候補。最高スコアのものを使用
- **マージ重み**: 元のクエリ結果 0.4 + hop-1 結果 0.3 + hop-2 結果 0.3 でスコアを加重結合
- **フォールバック条件**: (a) サブクエリ生成失敗、(b) hop-1 検索結果が 0 件、(c) ブリッジエンティティ抽出失敗、(d) LLM サブクエリ生成タイムアウト（各ホップ 3 秒）、(e) 分解パス全体タイムアウト（8 秒）— いずれの場合も元のシングルクエリにフォールバック

- 受入基準:
  - [ ] Bridge 問題で hop-1 サブクエリが生成される
  - [ ] hop-1 結果からブリッジエンティティが抽出される（エビデンスベース）
  - [ ] hop-2 サブクエリにブリッジエンティティが組み込まれる
  - [ ] 両ホップの結果が加重マージされて PPR に渡される
  - [ ] サブクエリ生成の LLM 呼び出しは低コストモデル（gpt-5.4-mini）を使用
  - [ ] フォールバック条件 (a)〜(e) のいずれかで元のクエリにフォールバック
  - [ ] `subQueryDecomposed` / `bridgeEntityExtracted` / `subQueryFallbackReason` メトリクスが記録される

**REQ-MG3-008**: THE system SHALL NOT apply sub-query decomposition to comparison-type questions, as these require both entities in the same context.

- 受入基準:
  - [ ] Comparison 問題では従来のシングルクエリパイプラインが使用される
  - [ ] `isComparisonQuery()` 判定が正しく機能する

### 2.5 フィーチャーフラグ

**REQ-MG3-009**: THE system SHALL provide independent feature flags for each improvement, allowing individual enable/disable control:

**インデキシング時フラグ**（将来のインデックスビルドにのみ影響。既構築済み辞書データには影響しない）:

| フラグ | デフォルト | 対象要件 |
|--------|----------|---------|
| `enableDictionaryIndexing` | true | REQ-MG3-001, 002 |

**クエリ時フラグ**（辞書データが存在しても、無効時は参照しない）:

| フラグ | デフォルト | 対象要件 |
|--------|----------|---------|
| `enableDictionaryInjection` | true | REQ-MG3-003 |
| `enableThesaurusExpansion` | true | REQ-MG3-004 (synonym のみ) |
| `enableHypernymExpansion` | false | REQ-MG3-004 (hypernym) |
| `enableAliasHints` | true | REQ-MG3-005 |
| `enableSubQueryDecomposition` | true | REQ-MG3-007 |
| `enableComparisonVerification` | true | REQ-MG3-014 |

**評価ハーネスフラグ**:

| フラグ | デフォルト | 対象要件 |
|--------|----------|---------|
| `enableEvalAliasNormalization` | true | REQ-MG3-006 |

- 受入基準:
  - [ ] 各フラグを個別に無効化できる
  - [ ] 全クエリ時フラグ + 評価フラグ無効時の動作が v15 と同一である（辞書データの有無に関わらず）
  - [ ] ベンチマークでフラグ別のアブレーション実験が実行可能

### 2.6 非機能要件

**REQ-MG3-010**: THE system SHALL maintain average query latency below 5 seconds (p95 below 10 seconds) per question on the cached LadybugDB backend.

- 受入基準:
  - [ ] 500 問ベンチマークの平均クエリ時間が 5 秒以下
  - [ ] p95 クエリ時間が 10 秒以下
  - [ ] サブクエリ分解がタイムアウト（各ホップ LLM 3 秒、分解パス全体 8 秒）した場合はフォールバック

**REQ-MG3-010a**: WHEN an existing corpus does not have dictionary/thesaurus data, THE system SHALL provide a backfill command (`memgraphrag lexicon build <corpusId>`) to construct Stage V data without full reindexing.

- 受入基準:
  - [ ] バックフィルコマンドが既存の facts/passages/schemas から辞書・シソーラスを構築する
  - [ ] フルリインデキシング（Stage I〜IV）は不要
  - [ ] ベンチマーク実行前にバックフィルが自動実行される（辞書が空の場合）

**REQ-MG3-011**: THE system SHALL NOT decrease accuracy below the v15 baseline (87.6%) on the HotpotQA 500-question benchmark with all flags enabled.

- 受入基準:
  - [ ] **プロダクト精度**（`enableEvalAliasNormalization=false`）が 87.6% 以上
  - [ ] **評価正規化込み精度**（`enableEvalAliasNormalization=true`）は別途報告（プロダクト精度ゲートには使用しない）
  - [ ] 各クエリ時フラグを個別に無効化しても精度が 85% 以上（退行上限 2.6pt）
  - [ ] アブレーション結果はフラグごとに絶対精度・v15 差分・全有効時差分を報告
  - [ ] 固定の 500 問セットで決定論的設定（temperature=0, SC=1）による再現可能な比較

**REQ-MG3-012**: WHILE all query-time and evaluation feature flags are disabled, THE system SHALL behave identically to v15 (graceful degradation), regardless of whether dictionary/thesaurus data has been populated.

- 受入基準:
  - [ ] 全クエリ時フラグ + 評価フラグ無効時に全クエリが正常に完了する
  - [ ] 全クエリ時フラグ + 評価フラグ無効時の精度が v15 と同一（87.6%）
  - [ ] 辞書データが存在する場合でも、フラグ無効時は参照されない

### 2.7 観測可能性

**REQ-MG3-013**: THE system SHALL record per-query metrics for all new features.

- 受入基準:
  - [ ] `QueryMetrics` に以下が追加される: `dictionaryInjectedCount`, `subQueryDecomposed`, `bridgeEntityExtracted`, `subQueryFallbackReason`, `aliasHintCount`, `comparisonVerified`
  - [ ] ベンチマーク結果 JSON に `evalAliasNormalized`, `evalOriginalCorrect`, `evalNormalizedCorrect` が記録される（product `QueryMetrics` には含まない）
  - [ ] ベンチマーク結果 JSON にフラグ別の精度内訳が含まれる

### 2.8 Comparison 回答検証

**REQ-MG3-014**: WHEN a comparison/yes-no question is answered, THE system SHALL verify that the LLM response includes explicit attribute/value for each compared entity before deriving the yes/no answer.

- 受入基準:
  - [ ] Comparison 問題で回答に両エンティティの比較属性が含まれない場合、再生成を 1 回試行する（プロンプトに「各エンティティの属性を明示してから回答せよ」を追加）
  - [ ] 再生成後も不十分な場合は初回回答を採用（回答拒否はしない）
  - [ ] `comparisonVerified` メトリクスが記録される

## 3. スコープ外

- 辞書の手動キュレーション UI
- 多言語対応（日本語等）
- コーパス間の辞書共有
- LadybugDB 固有の辞書ストレージ（SQLite テーブルを継続使用）
- 辞書エントリのバージョニング

## 4. トレーサビリティ

| 要件 ID | 対応設計 | 対応テスト |
|---------|---------|-----------|
| REQ-MG3-001 | DES-MG3-001 | TBD |
| REQ-MG3-002 | DES-MG3-002 | TBD |
| REQ-MG3-003 | DES-MG3-003 | TBD |
| REQ-MG3-004 | DES-MG3-004 | TBD |
| REQ-MG3-005 | DES-MG3-005 | TBD |
| REQ-MG3-006 | DES-MG3-006 | TBD |
| REQ-MG3-007 | DES-MG3-007 | TBD |
| REQ-MG3-008 | DES-MG3-008 | TBD |
| REQ-MG3-009 | DES-MG3-009 | TBD |
| REQ-MG3-010 | DES-MG3-010 | TBD |
| REQ-MG3-010a | DES-MG3-010a | TBD |
| REQ-MG3-011 | DES-MG3-011 | TBD |
| REQ-MG3-012 | DES-MG3-012 | TBD |
| REQ-MG3-013 | DES-MG3-013 | TBD |
| REQ-MG3-014 | DES-MG3-014 | TBD |

## 5. 目標精度

| 改善 | 期待される効果 | 根拠 |
|------|--------------|------|
| 辞書自動構築 + 候補注入 | +1〜2pt | 48 件の情報ギャップの一部を辞書ベースの候補注入で解決 |
| エイリアスヒント（プロンプト） | +1〜2pt | 12 件のエイリアス問題の部分解決 |
| 評価エイリアス正規化 | +0.5〜1pt | 表記揺れによる偽陰性の吸収（ベンチマーク計測のみ） |
| 2-hop サブクエリ（逐次分解） | +2〜4pt | 48 件の情報ギャップの根本対策（bridge 問題の検索精度向上） |
| **合計** | **+4〜8pt** | 87.6% → **91〜95%** 目標 |

## 6. Rubber-duck レビュー対応

### v1.0 → v1.1

| # | 指摘 | 対応 |
|---|------|------|
| B1 | REQ-MG3-005 がプロダクト動作とベンチマーク評価を混同 | REQ-MG3-005（プロンプトヒント）と REQ-MG3-006（評価ハーネス）に分離 |
| B2 | 辞書ブーストは既検索候補のみ。情報ギャップに効かない | REQ-MG3-003 を「候補注入」に変更。ベクトル検索結果外からもファクトを追加 |
| B3 | 共起のみでのシソーラス構築はノイズリスク大 | REQ-MG3-002 にルールベース判定基準を明記。共起のみは不十分と規定 |
| B4 | 2-hop の並列分解は bridge 問題に不適切 | REQ-MG3-007 を逐次分解（hop-1 → ブリッジエンティティ抽出 → hop-2）に変更 |
| B5 | graceful degradation の範囲が曖昧 | REQ-MG3-012 で「全フラグ無効時に v15 同一」と明確化 |
| B6 | フィーチャーフラグ要件が欠落 | REQ-MG3-009 として 6 つの独立フラグを追加 |

### v1.1 → v1.2

| # | 指摘 | 対応 |
|---|------|------|
| B1 | 評価エイリアス正規化がプロダクト退行をマスクする | REQ-MG3-011 の精度ゲートを `enableEvalAliasNormalization=false` で計測に変更 |
| B2 | 辞書構築にエンティティ解決セマンティクスが欠落 | REQ-MG3-001 にエイリアスリンクルール・正規形選択・曖昧性除外を追加 |
| B3 | synonym 判定が NER+Jaccard≥0.6 で甘すぎる | Jaccard を 0.8 に厳格化。文字列類似度は候補生成のみ、十分条件にしない |
| B4 | 辞書注入の上限・マッチング・スコアが未指定 | REQ-MG3-003 に注入ルール詳細（上限 10/30、トークン境界、信頼度閾値）を追加 |
| B5 | 2-hop 分解が実装に不十分 | REQ-MG3-007 に Bridge 検出基準・LLM 出力スキーマ・ブリッジ信頼度・マージ重み・フォールバック条件を追加 |
| NB6 | フィーチャーフラグがインデキシング時とクエリ時を混同 | REQ-MG3-009 をインデキシング時/クエリ時/評価ハーネスに 3 分類 |
| NB7 | コーパススコープが未指定 | REQ-MG3-001, 002 に `corpus_id` スコープを明記 |
| NB8 | hypernym 展開がクエリを希釈する | hypernym 展開をデフォルト無効（`enableHypernymExpansion=false`）に変更 |
| NB9 | Yes/No 反転エラーが未対処 | REQ-MG3-014 として Comparison 回答検証を追加 |
| NB10 | アブレーション精度ゲートが弱い | REQ-MG3-011 にフラグ別の絶対精度・v15差分・全有効時差分の報告を要求 |

### v1.2 → v1.3

| # | 指摘 | 対応 |
|---|------|------|
| B1 | エイリアスルール(a)が head/tail 部分文字列で誤エイリアスを生成 | ルール(a)を削除。同格構文 + NER+Jaccard の 2 ルールのみに限定 |
| B2 | `boostFactor` が未定義 | `baseScore`（ベクトル検索シード最大値 × 0.3）に変更。明確な定義を追加 |
| B3 | 曖昧エイリアス除外が弱い | グローバルルールとして全サブシステムに適用を明記 |
| NB4 | Comparison 検証が両エンティティ言及のみ | 比較属性の明示を要求するプロンプト強化に変更 |
| NB5 | 2-hop タイムアウトスコープが曖昧 | 各ホップ LLM 3s + 分解パス全体 8s に明確化 |
| NB6 | シソーラス削除がコーパス削除時に漏れる | REQ-MG3-002 にコーパス削除時のシソーラス削除を追加 |
| NB7 | 既存コーパスのバックフィル未定義 | REQ-MG3-010a としてバックフィルコマンドを追加 |
| S8 | 評価正規化の方向が曖昧 | 対称的正規化（予測+gold 両方を等価集合に変換）を明記 |
