# REQ-AIRA-GRAPHDB-001: aira-graphdb 要件定義（Phase 1）

| フィールド | 値 |
|-----------|---|
| **ID** | REQ-AIRA-GRAPHDB-001 |
| **バージョン** | 1.1 |
| **ステータス** | Draft |
| **作成日** | 2026-06-20 |
| **更新日** | 2026-06-20 |
| **パッケージ** | `packages/aira-graphdb`（Rust crate） |
| **対象バージョン** | v0.1.0 |

## 1. 背景

`aira-synapse` から利用する新規 GraphDB を Rust でゼロから開発する。  
利用形態は以下の両立を前提とする。

- SQLite / LadybugDB のようなファイルベース（埋め込み）
- Neo4j のようなサーバーベース（常駐プロセス）

対象ユーザーは AIRA エコシステムの他サービス開発者であり、P0 は Property Graph CRUD / Cypher 互換クエリ / 永続化 / Python・Node SDK とする。

## 2. 機能要件（EARS）

### REQ-AGDB-001: Property Graph 永続化コア

**種別**: UBIQUITOUS  
**優先度**: P0

**要件**:  
THE システム SHALL Rust ベースで Property Graph（Node / Edge / Property）を永続化するコアDBを提供する。

**受入基準**:
- [ ] ノード、エッジ、プロパティの作成・読取・更新・削除が可能
- [ ] DB再起動後も永続化データを再読込できる
- [ ] ノードID、エッジIDが一意に管理される

**トレーサビリティ**: DES-AIRA-GRAPHDB-001（予定）  
**パッケージ**: `packages/aira-graphdb`  
**CLI**: `cargo run -p aira-graphdb -- db check`

---

### REQ-AGDB-002: 埋め込みモード

**種別**: COMPLEX  
**優先度**: P0

**要件**:  
IF デプロイモードが `EMBEDDED` である場合, THEN THE システム SHALL ローカルDBファイルを直接操作し、常駐サーバープロセスなしで動作する。

**受入基準**:
- [ ] プロセス内ライブラリ呼び出しでDBを利用できる
- [ ] ローカルファイルパス指定でDBを開ける
- [ ] サーバー起動を必須としない

**トレーサビリティ**: DES-AIRA-GRAPHDB-001（予定）  
**パッケージ**: `packages/aira-graphdb`  
**CLI**: `cargo run -p aira-graphdb -- embedded open --file <path>`

---

### REQ-AGDB-003: サーバーモード

**種別**: COMPLEX  
**優先度**: P0

**要件**:  
IF デプロイモードが `SERVER` である場合, THEN THE システム SHALL 常駐サーバーとして起動し、TCP経由でクライアント接続を受け付ける。

**受入基準**:
- [ ] 単一コマンドでサーバー起動できる
- [ ] 指定ポートで待受できる
- [ ] 複数クライアント接続を処理できる

**トレーサビリティ**: DES-AIRA-GRAPHDB-001（予定）  
**パッケージ**: `packages/aira-graphdb`  
**CLI**: `cargo run -p aira-graphdb -- server start --port 7687`

---

### REQ-AGDB-004: Python/Node 共通プロトコル

**種別**: EVENT-DRIVEN  
**優先度**: P0

**要件**:  
WHEN Python または Node クライアントが接続を開始した場合, THE システム SHALL プロトコルバージョンネゴシエーションを実行し、合意した共通スキーマに従って型マッピング・エラーコード・結果順序規則を同一に適用する。  
IF クライアントが未対応バージョンを提示した場合, THEN THE システム SHALL `PROTOCOL_VERSION_MISMATCH` を返し、セッションを確立しない。

**受入基準**:
- [ ] Python SDK と Node SDK が同一プロトコルバージョンで接続できる
- [ ] 同一入力に対して同一型マッピング・同一エラーコード・同一行順序規則で応答する
- [ ] プロトコルバージョン不一致時に `PROTOCOL_VERSION_MISMATCH` を返す
- [ ] バージョン不一致時にセッションを確立しない

**トレーサビリティ**: DES-AIRA-GRAPHDB-001（予定）  
**パッケージ**: `packages/aira-graphdb`  
**CLI**: `cargo run -p aira-graphdb -- server protocol-version`

---

### REQ-AGDB-005: P0 Cypher サブセット実行

**種別**: EVENT-DRIVEN  
**優先度**: P0

**要件**:  
WHEN `{MATCH, WHERE, RETURN, CREATE, MERGE, DELETE, SET}` のみで構成されたクエリを受信した場合, THE システム SHALL P0 Cypher サブセット仕様に従い、同一DB状態・同一クエリに対して同一行集合を返す。  
IF クエリに `ORDER BY` が含まれない場合, THEN THE システム SHALL 行順序を保証しない。

**受入基準**:
- [ ] 対象7句のクエリが実行できる
- [ ] 同一DB状態・同一クエリで同一行集合を返す
- [ ] `ORDER BY` なしでは行順序非保証である
- [ ] 構文エラー時に標準化エラーコードを返す

**トレーサビリティ**: DES-AIRA-GRAPHDB-001（予定）  
**パッケージ**: `packages/aira-graphdb`  
**CLI**: `cargo run -p aira-graphdb -- query "MATCH (n) RETURN n"`

---

### REQ-AGDB-006: 非対応Cypher句の拒否

**種別**: UNWANTED  
**優先度**: P0

**要件**:  
THE システム SHALL NOT 未対応のCypher句を部分実行し、`UNSUPPORTED_FEATURE` エラーを返す。

**受入基準**:
- [ ] 未対応句を含むクエリは部分更新を起こさない
- [ ] `UNSUPPORTED_FEATURE` エラーコードを返す
- [ ] エラーメッセージに未対応句名を含む

**トレーサビリティ**: DES-AIRA-GRAPHDB-001（予定）  
**パッケージ**: `packages/aira-graphdb`  
**CLI**: `cargo run -p aira-graphdb -- query "OPTIONAL MATCH ..."`

---

### REQ-AGDB-007: COMMIT 成功時の耐久化保証

**種別**: EVENT-DRIVEN  
**優先度**: P0

**要件**:  
WHEN トランザクションの `COMMIT` が成功を返した場合, THE システム SHALL プロセスクラッシュまたはホスト再起動後に当該更新を回復可能にする。

**受入基準**:
- [ ] COMMIT成功後の障害復旧で更新が保持される
- [ ] WALまたは同等メカニズムが有効である
- [ ] 復旧後に整合性チェックを通過する

**トレーサビリティ**: DES-AIRA-GRAPHDB-001（予定）  
**パッケージ**: `packages/aira-graphdb`  
**CLI**: `cargo run -p aira-graphdb -- db recover --file <path>`

---

### REQ-AGDB-008: クラッシュ後の部分反映禁止

**種別**: UNWANTED  
**優先度**: P0

**要件**:  
THE システム SHALL NOT クラッシュ復旧後に単一トランザクションの部分的副作用を可視化する。

**受入基準**:
- [ ] 復旧後、トランザクションは全反映または無反映のどちらか
- [ ] 部分更新を検出した場合は起動を失敗させる
- [ ] 整合性違反を監査ログに記録する

**トレーサビリティ**: DES-AIRA-GRAPHDB-001（予定）  
**パッケージ**: `packages/aira-graphdb`  
**CLI**: `cargo run -p aira-graphdb -- db verify --file <path>`

---

### REQ-AGDB-009: 公式SDK提供（Python/Node）

**種別**: UBIQUITOUS  
**優先度**: P0

**要件**:  
THE システム SHALL Python SDK および Node SDK を公式提供し、P0のCRUD・クエリAPIを同等機能で公開する。

**受入基準**:
- [ ] Python SDK と Node SDK の主要APIが機能等価
- [ ] 接続、CRUD、クエリ、トランザクションAPIを提供
- [ ] サンプルコードで基本操作を実行できる

**トレーサビリティ**: DES-AIRA-GRAPHDB-001（予定）  
**パッケージ**: `packages/aira-graphdb`, `sdk/python`, `sdk/node`  
**CLI**: `npm run sdk:node:test` / `python -m pytest sdk/python/tests`

---

### REQ-AGDB-010: ROLLBACK 無副作用

**種別**: EVENT-DRIVEN  
**優先度**: P0

**要件**:  
WHEN トランザクションが `ROLLBACK` された場合, THE システム SHALL 当該トランザクションの副作用を永続化しない。

**受入基準**:
- [ ] ROLLBACK後に作成・更新・削除が反映されない
- [ ] サーバー再起動後も副作用がない
- [ ] ROLLBACKイベントを監査ログに記録する

**トレーサビリティ**: DES-AIRA-GRAPHDB-001（予定）  
**パッケージ**: `packages/aira-graphdb`  
**CLI**: `cargo run -p aira-graphdb -- tx rollback-test --file <path>`

---

### REQ-AGDB-011: 競合トランザクションの決定的動作

**種別**: EVENT-DRIVEN  
**優先度**: P0

**要件**:  
WHEN 同一ノードまたは同一エッジに対する書込み競合トランザクションが発生した場合, THE システム SHALL `SERIALIZABLE` 分離レベルで実行し、少なくとも1件をコミットし、他を `RETRYABLE_CONFLICT` で中止する。

**受入基準**:
- [ ] 競合時の戻り値が成功または `RETRYABLE_CONFLICT` に限定される
- [ ] 同一条件で非決定的な結果を返さない
- [ ] 分離レベルが `SERIALIZABLE` であることを設定またはメタ情報で確認できる

**トレーサビリティ**: DES-AIRA-GRAPHDB-001（予定）  
**パッケージ**: `packages/aira-graphdb`  
**CLI**: `cargo run -p aira-graphdb -- tx conflict-test --file <path>`

---

### REQ-AGDB-012: エッジ参照整合性

**種別**: EVENT-DRIVEN  
**優先度**: P0

**要件**:  
WHEN エッジの作成または更新を要求された場合, THE システム SHALL 始点ノードと終点ノードの存在を検証し、存在しない参照を拒否する。

**受入基準**:
- [ ] 存在しないノード参照のエッジ作成を拒否する
- [ ] 拒否時は標準化エラーコードを返す
- [ ] 参照整合性違反を監査ログに記録する

**トレーサビリティ**: DES-AIRA-GRAPHDB-001（予定）  
**パッケージ**: `packages/aira-graphdb`  
**CLI**: `cargo run -p aira-graphdb -- query "CREATE ()-[:R]->(:Missing)"`

---

### REQ-AGDB-013: unsafe同時書き込み禁止

**種別**: UNWANTED  
**優先度**: P0

**要件**:  
WHEN embedded モードまたは server モードのいずれかが同一DBファイルに対して排他書込みロックを保持中に、別プロセスが書込み可能モードでオープンを要求した場合, THE システム SHALL `WRITE_LOCK_CONFLICT` を返して要求を拒否し、対象ファイルを変更しない。

**受入基準**:
- [ ] 同一ファイルへの二重writer起動を拒否する
- [ ] ロック競合時に `WRITE_LOCK_CONFLICT` を返す
- [ ] 競合拒否時に対象ファイルを変更しない

**トレーサビリティ**: DES-AIRA-GRAPHDB-001（予定）  
**パッケージ**: `packages/aira-graphdb`  
**CLI**: `cargo run -p aira-graphdb -- lock test --file <path>`

---

### REQ-AGDB-014: フォーマット互換エラー

**種別**: EVENT-DRIVEN  
**優先度**: P0

**要件**:  
WHEN 非互換フォーマットバージョンのDBファイルをロードした場合, THE システム SHALL `INCOMPATIBLE_FORMAT` エラーで失敗し、データを変更しない。

**受入基準**:
- [ ] 非互換ファイル読み込み時に起動失敗する
- [ ] `INCOMPATIBLE_FORMAT` エラーを返す
- [ ] 読み込み失敗時にファイル内容が不変である

**トレーサビリティ**: DES-AIRA-GRAPHDB-001（予定）  
**パッケージ**: `packages/aira-graphdb`  
**CLI**: `cargo run -p aira-graphdb -- db open --file <path>`

---

### REQ-AGDB-015: サーバー認証必須

**種別**: EVENT-DRIVEN  
**優先度**: P0

**要件**:  
WHEN server モードで未認証クライアントがクエリまたはトランザクション要求を送信した場合, THE システム SHALL `AUTH_REQUIRED` を返して要求を拒否する。  
WHEN server モードで認証情報の検証に失敗した場合, THE システム SHALL `AUTH_FAILED` を返してセッションを確立しない。  
IF 接続が暗号化されていない場合, THEN THE システム SHALL セッション確立前に接続を拒否する。

**受入基準**:
- [ ] 未認証接続を拒否する
- [ ] 認証成功後にのみクエリ実行可能
- [ ] 未認証要求に `AUTH_REQUIRED` を返す
- [ ] 認証検証失敗時に `AUTH_FAILED` を返す
- [ ] 非暗号化接続をセッション確立前に拒否する
- [ ] 認証失敗イベントを監査ログに記録する

**トレーサビリティ**: DES-AIRA-GRAPHDB-001（予定）  
**パッケージ**: `packages/aira-graphdb`  
**CLI**: `cargo run -p aira-graphdb -- auth test --port 7687`

---

### REQ-AGDB-016: 標準エラーコードの固定定義

**種別**: UBIQUITOUS  
**優先度**: P0

**要件**:  
THE システム SHALL クエリ・トランザクション・認証・整合性検証で発生する各失敗種別に対して固定エラーコードを1対1で定義し、Python SDK・Node SDK・サーバーCLIで同一コードを返す。

**受入基準**:
- [ ] 失敗種別とエラーコードの対応表を仕様として保持する
- [ ] Python SDK、Node SDK、サーバーCLIで同一失敗に同一エラーコードを返す
- [ ] 既存の `PROTOCOL_VERSION_MISMATCH` / `UNSUPPORTED_FEATURE` / `RETRYABLE_CONFLICT` / `WRITE_LOCK_CONFLICT` / `INCOMPATIBLE_FORMAT` / `AUTH_REQUIRED` / `AUTH_FAILED` を固定コードとして扱う

**トレーサビリティ**: DES-AIRA-GRAPHDB-001（予定）  
**パッケージ**: `packages/aira-graphdb`, `sdk/python`, `sdk/node`  
**CLI**: `cargo run -p aira-graphdb -- errors list`

## 3. 非機能要件

### REQ-AGDB-NF-001: P0レイテンシ目標（単一ノード）

**種別**: STATE-DRIVEN  
**優先度**: P1

**要件**:  
WHILE 単一ノード構成でベンチマークプロファイル `P0-LATENCY-BASELINE`（10万ノード、同時実行1、ウォームアップ後）を実行中, THE システム SHALL 単純MATCH/RETURNクエリのP95レイテンシを 50ms 以下に維持する。

**受入基準**:
- [ ] `P0-LATENCY-BASELINE` 条件下で P95 50ms 以下
- [ ] ベンチマーク結果をレポートとして保存する

**トレーサビリティ**: DES-AIRA-GRAPHDB-001（予定）  
**パッケージ**: `packages/aira-graphdb`  
**CLI**: `cargo run -p aira-graphdb -- bench latency`

---

### REQ-AGDB-NF-002: 将来クラスタ移行メタデータ

**種別**: STATE-DRIVEN  
**優先度**: P1

**要件**:  
WHILE 単一ノードモードで運用中, THE システム SHALL 将来の水平分散移行に備えて partition と replica のメタデータをバージョン付きシステムカタログに永続化する。

**受入基準**:
- [ ] system catalog に partition/replica メタ情報を保持する
- [ ] catalog schema version を確認できる
- [ ] メタデータ移行手順をドキュメント化する

**トレーサビリティ**: DES-AIRA-GRAPHDB-001（予定）  
**パッケージ**: `packages/aira-graphdb`  
**CLI**: `cargo run -p aira-graphdb -- catalog show`

## 4. スコープ外（v0.1.0）

- 分散クラスタの本実装（リーダー選出、再配置、自動フェイルオーバー）
- Cypher 全機能互換（CALL, procedure, APOC 相当）
- 多テナント課金機能
