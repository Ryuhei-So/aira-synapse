# REQ-MEMGRAPH-001: Memory-based GraphRAG 要件定義書

**Document ID**: REQ-MEMGRAPH-001
**Version**: 1.0
**Status**: 📝 Draft — レビュー待ち
**Created**: 2026-06-07
**Author**: SDD Phase 1 (Requirements Analyst)
**Reference**: MemGraphRAG (KDD 2026, arXiv:2606.00610v1)
**Prior Art**: altanative-lazygraphrag (LazyGraphRAG 実装)

---

## 1. 概要

本要件定義書は、MemGraphRAG 論文に基づく Memory-based GraphRAG システムの
TypeScript/ESM 再実装に関する要件を EARS 形式で定義する。

### 1.1 背景

既存の GraphRAG システムは、ドキュメントチャンクを独立に処理する
「断片的ローカル抽出」パラダイムに依存しており、以下の3つの品質劣化を招く:

1. **テーマ的無関連性（Thematic Irrelevance）**: 主題と無関係なトリプルの混入
2. **論理的矛盾（Logical Inconsistency）**: 相互排他的・時間的・粒度の矛盾
3. **構造的断片化（Structural Fragmentation）**: 孤立ノードと非連結コンポーネント

### 1.2 ソリューション概要

MemGraphRAG は、3層グローバルメモリとマルチエージェント協調により
知識グラフ構築の品質を保証し、メモリ誘導型検索で高精度な回答を生成する。

### 1.3 スコープ

| 含まれるもの | 含まれないもの |
|-------------|--------------|
| 3層グローバルメモリ管理 | Web UI |
| マルチエージェントグラフ構築 | マルチテナント |
| メモリ誘導型検索 | リアルタイムストリーミング |
| CLI インターフェース | 分散処理 |
| パイプライン管理 | GPU アクセラレーション |

---

## 2. ドメインモデル要件

### 2.1 スキーマ（Schema）

**REQ-MEMGRAPH-001**: THE システム SHALL スキーマを `(head_type, relation, tail_type)` のタプルとして表現する。

**REQ-MEMGRAPH-002**: THE システム SHALL 各スキーマに抽出頻度（frequency）カウンターを保持する。

**REQ-MEMGRAPH-003**: WHEN スキーマの抽出頻度が閾値 τ 以上に達した場合, THE システム SHALL 当該スキーマを候補（candidate）から安定（stable）に昇格させる。

**REQ-MEMGRAPH-004**: WHILE スキーマが候補状態である間, THE システム SHALL 当該スキーマに関連するファクトをグラフ構築から除外する。

### 2.2 ファクト（Fact）

**REQ-MEMGRAPH-005**: THE システム SHALL ファクトを `(head_entity, relation, tail_entity)` のトリプルとして表現する。

**REQ-MEMGRAPH-006**: THE システム SHALL 各ファクトをそのソースとなるスキーマにリンクする。

**REQ-MEMGRAPH-007**: THE システム SHALL 各ファクトに「アクティブ（active）」または「非アクティブ（inactive）」の状態を持たせる。

**REQ-MEMGRAPH-008**: WHEN ファクトに関連するスキーマが安定状態に昇格した場合, THE システム SHALL 当該ファクトをアクティブ状態に遷移させる。

### 2.3 パッセージ（Passage）

**REQ-MEMGRAPH-009**: THE システム SHALL パッセージを元ドキュメントのテキストチャンクとして保持する。

**REQ-MEMGRAPH-010**: THE システム SHALL 各パッセージをそれが根拠となるファクト群にリンクする（fact-evidence grounding）。

### 2.4 エンティティ（Entity）

**REQ-MEMGRAPH-011**: THE システム SHALL エンティティに名前とタイプを持たせる。

**REQ-MEMGRAPH-012**: THE システム SHALL タイプ関数 φ(entity) = type によりエンティティをタイプに分類する。

### 2.5 オントロジー（Ontology）

**REQ-MEMGRAPH-013**: THE システム SHALL オントロジーを有効なスキーマの集合 O = {s1, ..., s|O|} として管理する。

---

## 3. 3層グローバルメモリ要件

### 3.1 メモリ構造

**REQ-MEMGRAPH-014**: THE システム SHALL グローバルメモリ M を以下の3層で構成する:
- オントロジー層（M_ont）: スキーマと抽出頻度
- ファクト層（M_fac）: 具体的ファクトとアクティブ/非アクティブ状態
- パッセージ層（M_pas）: 元テキストパッセージ

**REQ-MEMGRAPH-015**: THE システム SHALL 各メモリ層間の双方向参照を維持する:
- スキーマ-インスタンス整合: スキーマとファクトの紐付け
- ファクト-エビデンス接地: ファクトとパッセージの紐付け

### 3.2 オントロジー層（M_ont）

**REQ-MEMGRAPH-016**: THE システム SHALL オントロジー層にスキーマを頻度カウント付きで格納する。

**REQ-MEMGRAPH-017**: THE システム SHALL オントロジー層でスキーマの候補/安定ステータスを管理する。

**REQ-MEMGRAPH-018**: WHEN 新しいスキーマが抽出された場合, THE システム SHALL 既存の同等スキーマが存在するか検査し、存在すれば頻度をインクリメントする。

### 3.3 ファクト層（M_fac）

**REQ-MEMGRAPH-019**: THE システム SHALL ファクト層にアクティブファクトと非アクティブファクトを格納する。

**REQ-MEMGRAPH-020**: WHEN 新しいファクトがアクティブになった場合, THE システム SHALL 矛盾検出パイプラインをトリガーする。

### 3.4 パッセージ層（M_pas）

**REQ-MEMGRAPH-021**: THE システム SHALL パッセージ層にソースパッセージとエンベディングベクトルを格納する。

**REQ-MEMGRAPH-022**: THE システム SHALL パッセージ層で類似度ベースの検索を提供する。

---

## 4. マルチエージェントグラフ構築要件

### 4.1 抽出エージェント（Extraction Agent）

**REQ-MEMGRAPH-023**: THE システム SHALL 抽出エージェント A_ext を提供し、ドキュメントチャンクから3層メモリへのエントリを生成する: `A_ext(c_i) → {S_cand ∈ M_ont, T_cand ∈ M_fac, P_src ∈ M_pas}`

**REQ-MEMGRAPH-024**: THE システム SHALL 抽出エージェントが LLM を使用してスキーマ・ファクト・パッセージを同時に抽出する。

**REQ-MEMGRAPH-025**: THE システム SHALL 抽出時に各ファクトをそのソーススキーマとソースパッセージにリンクする。

### 4.2 矛盾検出エージェント（Conflict Detection Agent）

**REQ-MEMGRAPH-026**: WHEN 新しいファクトがアクティブになった場合, THE システム SHALL 矛盾検出エージェント A_det がファクト層を非同期スキャンし、矛盾候補集合 F_conf を特定する。

**REQ-MEMGRAPH-027**: THE システム SHALL 以下の矛盾タイプを検出する:
- 相互排他的矛盾（Mutually Exclusive Conflict）
- 時間的矛盾（Temporal Conflict）
- 粒度矛盾（Granularity Conflict）

**REQ-MEMGRAPH-028**: THE システム SHALL 意味的類似度（Sim > δ）またはオントロジー構造マッチングに基づいて矛盾を検出する。

### 4.3 矛盾解決エージェント（Conflict Resolution Agent）

**REQ-MEMGRAPH-029**: WHEN 矛盾候補集合 F_conf が非空の場合, THE システム SHALL 矛盾解決エージェント A_res をトリガーする。

**REQ-MEMGRAPH-030**: THE システム SHALL 矛盾解決時にパッセージ層 M_pas から元のエビデンスパッセージを取得し、テキスト証拠の比較に基づいて判定する。

**REQ-MEMGRAPH-031**: THE システム SHALL 以下の解決アクションを実行する:
- 無効ファクトのフィルタリング（非アクティブ化）
- 冗長トリプルのマージ
- 時間的・粒度的矛盾の解決

### 4.4 エージェント協調

**REQ-MEMGRAPH-032**: THE システム SHALL 抽出・検出・解決の3エージェントを関心分離原則に基づいて独立に実装する。

**REQ-MEMGRAPH-033**: THE システム SHALL エージェント間の通信を共有グローバルメモリ M を介して行う。

---

## 5. テーマ的ノイズ除去要件（Thematic Denoising）

**REQ-MEMGRAPH-034**: THE システム SHALL 統一スキーマフィルタリングにより、テーマ的に無関連なトリプルを除去する。

**REQ-MEMGRAPH-035**: THE システム SHALL スキーマの安定性閾値 τ を設定パラメータとして公開する。

**REQ-MEMGRAPH-036**: THE システム SHALL NOT 安定スキーマに紐づかないファクトをグラフ構築に使用する。

---

## 6. 階層的インデキシンググラフ要件

### 6.1 グラフ構成

**REQ-MEMGRAPH-037**: THE システム SHALL 階層的インデキシンググラフ G を以下の3ビューで構成する:
- セマンティックオントロジーグラフ G_ont: スキーマレベルの型関係
- ファクトグラフ G_fac: エンティティ-関係トリプル
- ソースエビデンスグラフ G_pas: ファクトとソースパッセージのリンク

**REQ-MEMGRAPH-038**: THE システム SHALL 3つのグラフビューを相互接続し、抽象セマンティクスからグラウンデッドエビデンスへのトラバーサルを可能にする。

### 6.2 構造統一（Structural Unification）

**REQ-MEMGRAPH-039**: THE システム SHALL メモリ誘導型ブリッジングにより構造的断片化を解消する。

**REQ-MEMGRAPH-040**: THE システム SHALL タイプベース接続（共有安定スキーマタイプに基づく）によりブリッジエッジを追加する。

**REQ-MEMGRAPH-041**: THE システム SHALL 類似度ベース接続（高エンベディング類似度のエンティティ間）によりブリッジエッジを追加する。

---

## 7. メモリ誘導型検索要件

### 7.1 マルチレイヤーメモリフィルタリング

**REQ-MEMGRAPH-042**: WHEN ユーザークエリ q を受信した場合, THE システム SHALL 3層メモリ M から並列にTop-K候補を検索する。

**REQ-MEMGRAPH-043**: THE システム SHALL 意味的類似度 Sim(q, x) > τ を満たすスキーマとファクトのみを保持する。

**REQ-MEMGRAPH-044**: IF 有効な構造的候補が残らない場合（S_ret ∪ F_ret = ∅）, THEN THE システム SHALL パッセージ層 M_pas からの類似度ベース検索にフォールバックする。

### 7.2 構造認識ノード初期化

**REQ-MEMGRAPH-045**: THE システム SHALL エンティティノードを、関連ファクトの平均類似度に基づいて初期化する: `P_init(e) = (1/|F_e|) × Σ Sim(q, f)`

**REQ-MEMGRAPH-046**: THE システム SHALL タイプノードを、スキーマ関連性とハブ抑制の組み合わせで初期化する: `P_init(t) = (平均スキーマ類似度) × 1/log(deg(t)+1)`

**REQ-MEMGRAPH-047**: THE システム SHALL パッセージノードを、意味的類似度と情報密度の組み合わせで初期化する: `P_init(p) = Sim(q, d_p) × α × σ(ΣIDFスコア / log(|E_p|+1))`

### 7.3 Personalized PageRank

**REQ-MEMGRAPH-048**: THE システム SHALL Personalized PageRank (PPR) を異種グラフ上で実行し、クエリ固有の重要度を伝播する。

**REQ-MEMGRAPH-049**: THE システム SHALL PPR のダンピングファクター λ を設定パラメータとして公開する（デフォルト: 0.5）。

**REQ-MEMGRAPH-050**: WHEN PPR が収束した場合, THE システム SHALL Top-K パッセージと Top-M エンティティを LLM 推論用に選択する。

---

## 8. パイプライン要件

### 8.1 インデキシングパイプライン（オフライン）

**REQ-MEMGRAPH-051**: THE システム SHALL オフラインインデキシングパイプラインを提供し、非構造化ドキュメントコーパスから階層的インデキシンググラフを構築する: `G = GraphConstructor(D)`

**REQ-MEMGRAPH-052**: THE システム SHALL インデキシングパイプラインの進捗状況をレポートする。

**REQ-MEMGRAPH-053**: THE システム SHALL インデキシング結果を永続化し、再利用可能にする。

### 8.2 クエリパイプライン（オンライン）

**REQ-MEMGRAPH-054**: THE システム SHALL オンラインクエリパイプラインを提供し、クエリからメモリ誘導検索と回答生成を実行する: `a = LLM(Retriever(q, G))`

**REQ-MEMGRAPH-055**: THE システム SHALL クエリ処理の各ステージ（フィルタリング、初期化、PPR、生成）のメトリクスを記録する。

---

## 9. CLI インターフェース要件（Article II 準拠）

**REQ-MEMGRAPH-056**: THE システム SHALL CLI インターフェースとして以下のコマンドを提供する:
- `mnemosyne index <corpus-dir>` — インデキシングパイプライン実行
- `mnemosyne query <question>` — クエリパイプライン実行
- `mnemosyne memory stats` — メモリ統計表示
- `mnemosyne graph stats` — グラフ統計表示

**REQ-MEMGRAPH-057**: THE システム SHALL 全コマンドで `--config <path>` による設定ファイル指定をサポートする。

**REQ-MEMGRAPH-058**: THE システム SHALL コマンド実行結果を JSON 形式で出力するオプション `--json` を提供する。

---

## 10. 設定・パラメータ要件

**REQ-MEMGRAPH-059**: THE システム SHALL 以下のパラメータを設定可能にする:

| パラメータ | 説明 | デフォルト値 |
|-----------|------|-------------|
| `schema_threshold` (τ) | スキーマ安定化閾値 | 3 |
| `conflict_similarity_threshold` (δ) | 矛盾検出類似度閾値 | 0.8 |
| `retrieval_similarity_threshold` | 検索フィルタリング閾値 | 0.5 |
| `ppr_damping_factor` (λ) | PPR ダンピングファクター | 0.5 |
| `ppr_max_iterations` | PPR 最大反復回数 | 100 |
| `passage_dampening` (α) | パッセージ減衰係数 | 0.05 |
| `top_k_retrieval` | Top-K 検索件数 | 5 |
| `chunk_size` | チャンクサイズ（トークン数） | 1200 |
| `chunk_overlap` | チャンクオーバーラップ | 100 |

**REQ-MEMGRAPH-060**: THE システム SHALL YAML/JSON 形式の設定ファイルをサポートする。

---

## 11. 品質・非機能要件

### 11.1 テスト（Article III / IX 準拠）

**REQ-MEMGRAPH-061**: THE システム SHALL 各パッケージで 80% 以上のテストカバレッジを維持する。

**REQ-MEMGRAPH-062**: THE システム SHALL ユニットテスト・統合テストを分離して管理する。

### 11.2 パフォーマンス

**REQ-MEMGRAPH-063**: THE システム SHALL 単一クエリの検索レイテンシを 1 秒以内に抑える（1万ファクト規模）。

**REQ-MEMGRAPH-064**: THE システム SHALL LLM 呼び出しをバッチ処理し、API コール数を最小化する。

### 11.3 拡張性

**REQ-MEMGRAPH-065**: THE システム SHALL LLM プロバイダーを抽象化し、OpenAI/Azure OpenAI/ローカルモデルを切り替え可能にする。

**REQ-MEMGRAPH-066**: THE システム SHALL ベクトルストアを抽象化し、インメモリ/HNSW/外部サービスを切り替え可能にする。

### 11.4 永続化（Git Native 準拠）

**REQ-MEMGRAPH-067**: THE システム SHALL メモリとグラフのデータを JSON/YAML 形式でファイルシステムに永続化する。

**REQ-MEMGRAPH-068**: THE システム SHALL インデキシング結果のインクリメンタル更新をサポートする。

### 11.5 エラーハンドリング

**REQ-MEMGRAPH-069**: THE システム SHALL LLM API エラー時にリトライ（exponential backoff）を実行する。

**REQ-MEMGRAPH-070**: THE システム SHALL NOT LLM 抽出の失敗により全インデキシングパイプラインを停止する（GracefulDegradation）。

---

## 12. トレーサビリティ（Article V 準拠）

| 要件 ID | カテゴリ | ソース |
|---------|---------|--------|
| REQ-MEMGRAPH-001〜013 | ドメインモデル | 論文 §2.1 Key Definitions |
| REQ-MEMGRAPH-014〜022 | 3層グローバルメモリ | 論文 §4.1 Global Memory |
| REQ-MEMGRAPH-023〜033 | マルチエージェント | 論文 §4.1 Multi-Agent Group, §4.2 |
| REQ-MEMGRAPH-034〜036 | テーマ的ノイズ除去 | 論文 §4.2.1 |
| REQ-MEMGRAPH-037〜041 | 階層グラフ | 論文 §4.1, §4.2.3 |
| REQ-MEMGRAPH-042〜050 | メモリ誘導検索 | 論文 §4.3 |
| REQ-MEMGRAPH-051〜055 | パイプライン | 論文 §2.2 Problem Formulation |
| REQ-MEMGRAPH-056〜058 | CLI | Article II 準拠 |
| REQ-MEMGRAPH-059〜060 | 設定 | 論文 §5.1 Implementation Details |
| REQ-MEMGRAPH-061〜070 | 品質・非機能 | MUSUBIX2 憲法 / 論文 §5 |

---

## 13. 用語集

| 用語 | 定義 |
|------|------|
| **Schema** | (head_type, relation, tail_type) — 論理的制約を表す型レベルのトリプル |
| **Fact** | (head_entity, relation, tail_entity) — スキーマの具体的インスタンス |
| **Passage** | ファクト抽出の根拠となるソーステキスト |
| **Ontology** | 有効なスキーマの集合 |
| **Global Memory (M)** | Ontology/Fact/Passage の3層階層メモリ |
| **Hierarchical Graph (G)** | G_ont / G_fac / G_pas の3ビューから成る階層グラフ |
| **PPR** | Personalized PageRank — グラフ上のクエリ固有重要度伝播 |
| **Bridging Edge** | 構造的断片化を解消するための追加エッジ |
| **Hub Suppression** | 高次数タイプノードの影響を抑制する正則化 |

---

## 14. 承認

| ロール | 氏名 | 日付 | 状態 |
|-------|------|------|------|
| 要件定義者 | SDD Requirements Analyst | 2026-06-07 | ✅ Draft 完了 |
| レビュアー | — | — | ⏳ レビュー待ち |
| 承認者 | @nahisaho | — | ⏳ 承認待ち |
