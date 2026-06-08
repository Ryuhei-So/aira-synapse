# 技術スタック — aira-synapse

## 言語・ランタイム

| 技術 | バージョン | 用途 |
|------|-----------|------|
| **TypeScript** | 5.3+ | メイン言語 |
| **Node.js** | 20+ | ランタイム |
| **ESM** | `type: "module"` | モジュールシステム |
| **Python** | 3.10+ | NLP サイドカー（scispaCy + GiNZA） |

## ビルド・テスト

| ツール | 用途 |
|--------|------|
| `tsc -b` | インクリメンタルビルド |
| **Vitest** | テストフレームワーク（カバレッジ 80%+） |
| **ESLint** | リンター |

## 主要ライブラリ

| ライブラリ | 用途 |
|-----------|------|
| `@modelcontextprotocol/sdk` | MCP サーバー実装 |
| `commander` | CLI インターフェース |
| `better-sqlite3` | SQLite ストレージ |
| `openai` | LLM / Embedding プロバイダー |

## NLP サイドカー (Python)

| ライブラリ | 用途 |
|-----------|------|
| `spacy` | 基本 NLP |
| `scispacy` | 科学論文特化エンティティ抽出 |
| `en_core_sci_lg` | 英語科学モデル |
| `ginza` | 日本語 NLP ライブラリ（spaCy ベース） |
| `ja_ginza_electra` | GiNZA 日本語モデル（ELECTRA ベース） |

## コーディング規約

- エラー: `ActionableError` パターン
- リポジトリ: `IRepository` / `ISearchableRepository`
- CLI: `registerXCommand(program)` パターン
- ファクトリ: `createXxx()` 関数
- 永続化: JSON / YAML / Markdown（Git Native）、SQLite（権威ストア）
