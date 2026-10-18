<!--
Sync Impact Report
- Version change: (template) → 1.0.0
- Modified principles: 初版のため全項目を新規定義
- Added sections: Core Principles (I–VII), Technical Constraints, Development Workflow, Governance
- Removed sections: なし
- Templates requiring updates: なし（テンプレートは実行時に constitution を参照する）
- Follow-up TODOs: なし
-->

# Trebuchet Constitution

個人事業主（将来は法人も）向けの、ローカルで動くプライベート会計ソフト。
要件の正本は `docs/requirements.md`。

## Core Principles

### I. 帳簿の正確性（NON-NEGOTIABLE）

- 金額は MUST 整数（円）で扱う。浮動小数点で金額を計算・保存してはならない。
- すべての仕訳は MUST 借方合計 = 貸方合計 を満たす。満たさない仕訳は永続化層に到達させない。
- 確定済みの仕訳は MUST 変更・削除しない。訂正は取消仕訳と再登録で行う。
- 試算表・PL・BS は MUST 仕訳から導出する。集計値を独立して保存・編集しない。
- 上記の不変条件は MUST fast-check のプロパティベーステストで検証する。

理由: 会計データの誤りは税務申告に直結し、後から気づきにくい。

### II. 監査可能性（電子帳簿保存法）

- 仕訳と証憑は MUST 追記のみとし、訂正・取消の履歴（誰が・いつ・何を・なぜ）を残す。
- 仕訳と証憑は MUST 取引年月日・金額・取引先で検索できる。
- 証憑ファイルは MUST 内容ハッシュで識別し、仕訳との紐づけを保持する。
- データは MUST 7年以上保持できる形式（SQLite と元ファイル）で保存する。

### III. ローカルファーストとプライバシー

- アプリとデータは MUST 利用者の Mac 上で動作・保存する。インターネットへの公開や
  ホスティングはしない。リモートアクセスは Tailscale 経由に限る。
- 事業体（テナント）ごとに MUST DB ファイルを分離し、テナント間でデータを参照しない。
- 外部のAIに送る情報は MUST 必要最小限とし、口座番号・カード番号・個人の識別情報をマスクする。
- 帳簿データ、`work/`、秘密情報（APIキー、パスフレーズ）は MUST Git にコミットしない。
  秘密情報は macOS キーチェーンまたは `.env`（Git の管理外）で扱う。

### IV. AIは提案、確定は人

- AIの出力は MUST 「仕訳候補」であり、利用者が承認するまで帳簿に登録しない。
- AIの出力は MUST Zod スキーマで検証し、確信度と根拠を含める。
- AIプロバイダは MUST インターフェースで抽象化する（ルール → ローカル `fm` → クラウド）。
- AI機能の変更は MUST 評価データセット（Evals）での精度比較を伴う。

理由: 学習目的と正確性の両立。AIの誤りを帳簿に入れない仕組みを構造で担保する。

### V. テストファースト

- ドメインロジック（仕訳、集計、税計算、決算、取込）は MUST テストを先に書く（Red → Green → Refactor）。
- 会計の不変条件は MUST プロパティベーステストで書く。具体例のテストだけで済ませない。
- 取込機能は MUST 実データの形式を模した匿名化フィクスチャで、元帳との突合までテストする。
- 実データ（`work/` 配下）を MUST テストのフィクスチャとしてリポジトリに含めない。

### VI. 税制ルールはデータ

- 税率、少額資産の基準額、控除額などの税制パラメータは MUST 適用開始日つきのデータとして
  管理し、ロジックに直書きしない。
- 消費税の課税区分・経理方式は MUST 事業体×期間で切替可能にする。
- 税制データの変更は MUST 出典（国税庁などのURL）を記録する。

### VII. シンプルさと境界

- ドメイン層は MUST 純粋な TypeScript とし、Hono・React・DB に依存しない（後の Tauri 化に備える）。
- 現在のフェーズで不要な抽象化・汎用化は作らない（YAGNI）。複雑さを持ち込む場合は
  plan.md の Complexity Tracking に理由を書く。
- 外部の依存は、標準機能や既存の依存で代替できない場合に限って追加する。

## Technical Constraints

- 言語: TypeScript（`strict: true`）、ESM。パッケージ管理は pnpm の monorepo。
- 画面: Vite + React。API: Hono。DB: SQLite + Drizzle ORM。検証: Zod。
- テスト: Vitest + fast-check。E2E とスクレイピング: Playwright。
- 認証: パスキー（WebAuthn）。バックアップ: パスフレーズで暗号化して Google Drive へ。
- 対象環境: macOS（Apple Silicon）、Node.js の現行版。

## Development Workflow

- 機能ごとに Spec Kit の流れに従う: specify → (clarify) → plan → tasks → implement → converge。
- 仕様は「何を・なぜ」、plan は「どう作るか」を書く。仕様に実装の詳細を書かない。
- 機能ごとにブランチを切り、`main` へは CI（型検査・lint・テスト）が通った状態でのみマージする。
- 重要な設計判断は `docs/adr/` に ADR として記録する。
- AIエージェント向けの作業指示は `AGENTS.md` にまとめ、constitution と矛盾させない。
- コミットメッセージは Conventional Commits 形式とする。

## Governance

- この constitution は、ほかの開発ルール・慣習より優先する。
- 改定は、変更内容・理由・影響を Sync Impact Report に記載したうえで行う。
- バージョンはセマンティックバージョニング: 原則の削除・再定義は MAJOR、原則・節の追加は MINOR、
  文言の明確化は PATCH。
- plan.md の Constitution Check で各原則への適合を確認する。違反は Complexity Tracking で
  正当化されない限り認めない。

**Version**: 1.0.0 | **Ratified**: 2026-10-18 | **Last Amended**: 2026-10-18
