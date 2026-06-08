# aira-synapse 憲法

## Article I: ライブラリファースト
各機能を独立モジュールとして設計。アプリ依存を排除する。

## Article II: CLI インターフェース
全機能に Commander.js ベースの CLI インターフェースを提供する。

## Article III: テストファースト
Red → Green → Blue サイクル。Vitest カバレッジ 80% 以上。

## Article IV: EARS 形式
全要件は EARS（Easy Approach to Requirements Syntax）形式で記述する。

## Article V: トレーサビリティ
要件 ↔ 設計 ↔ コード ↔ テスト間の 100% トレーサビリティを維持する。

## Article VI: プロジェクトメモリ
steering/ を全スキル実行前に参照すること。

## Article VII: デザインパターン文書化
重要な設計パターンは ADR として記録する。

## Article VIII: ADR 記録
アーキテクチャ決定は ADR（Architecture Decision Record）として記録する。

## Article IX: 品質ゲート
各フェーズで品質ゲートを通過すること。
