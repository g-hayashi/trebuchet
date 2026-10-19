# Implementation Plan: 帳簿コア（事業体・勘定科目・仕訳・帳票）

**Branch**: `001-ledger-core` | **Date**: 2026-10-18 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-ledger-core/spec.md`

## Summary

個人事業の帳簿の中心を作る。事業体ごとに分離した SQLite ファイルに、勘定科目・期首残高・仕訳・変更履歴を保存し、
仕訳帳・総勘定元帳・試算表・PL・BS を仕訳から都度導出して表示する。会計ロジックはフレームワークから独立した
純粋な TypeScript のドメイン層に置き、貸借一致などの不変条件を fast-check のプロパティテストで検証する。
API は Hono（RPC で型を共有）、画面は React（Vite）で作る。

## Technical Context

**Language/Version**: TypeScript 7.0（`strict: true`, ESM）、Node.js 26.9

**Primary Dependencies**: Hono 4 ＋ @hono/node-server 2.1.3+ ＋ @hono/standard-validator、Zod 4、drizzle-orm 0.45 ＋ drizzle-kit 0.31、better-sqlite3 13（代替: node:sqlite）、React 19、Vite 8、TanStack Router / Query / Table、React Hook Form、Tailwind CSS 4 ＋ shadcn/ui

**Storage**: SQLite。`data/registry.sqlite`（事業体の一覧）と `data/tenants/<entityId>.sqlite`（事業体ごとの帳簿）

**Testing**: Vitest 5 ＋ fast-check 4（ユニット・プロパティ）、テンポラリの SQLite での統合テスト、Playwright（E2E 1本）

**Target Platform**: macOS（Apple Silicon）上のローカル Web アプリ。ブラウザは Safari / Chrome の最新版

**Project Type**: Web アプリケーション（pnpm monorepo: server ＋ web ＋ 共有パッケージ）

**Performance Goals**: 年2,000仕訳で各帳票を1秒以内に表示（SC-004）。1万仕訳のプロパティテストが数十秒以内に終わる

**Constraints**: 金額は整数のみ。物理削除なし。監査ログは追記のみ。`127.0.0.1` のみで待ち受け（認証は 003）。実データをリポジトリに含めない

**Scale/Scope**: 利用者1人、事業体1〜2、仕訳 年数千件、画面 約10

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 判定 | 根拠 |
|---|---|---|
| I. 帳簿の正確性 | ✅ | 金額は `INTEGER` ＋ ブランド型 `Yen`（R5）。貸借の検証はドメインで書込前に実施（INV-1）。帳票は都度導出（data-model §6）。INV-1〜10 をプロパティテストの対象として定義 |
| II. 監査可能性 | ✅ | `audit_log` はトリガーで追記のみ（INV-9）。物理削除はトリガーで禁止。日付・金額・取引先の検索 API（FR-023）。証憑は本機能の範囲外 |
| III. ローカルファースト | ✅ | テナントごとに DB ファイルを分離し、帳簿テーブルに `entity_id` を持たない（構造的な分離）。`127.0.0.1` のみ（R13）。`data/` と `work/` は Git の管理外 |
| IV. AIは提案 | N/A | 本機能に AI はない |
| V. テストファースト | ✅ | tasks でテストを実装より先に置く。フィクスチャは匿名化した合成データ。SC-008 の実データ照合はローカル専用（R6） |
| VI. 税制ルールはデータ | ✅ | 消費税の設定を適用開始日つきで保持（FR-009）。税区分は参照データ。税率は `tax_rates` に適用開始日と出典 URL つきで保持し、仕訳の日付で引く（data-model §2）。ロジックには内税額の計算式だけを置く |
| VII. シンプルさと境界 | ✅ | ドメイン層は Hono・React・DB に依存しない（contracts/domain-module.md）。パッケージは5つで、それぞれ境界の役割がある（R9） |

**Post-design re-check（Phase 1 後）**: ✅ 違反なし。Complexity Tracking は空。

## Project Structure

### Documentation (this feature)

```text
specs/001-ledger-core/
├── plan.md              # 本ファイル
├── research.md          # Phase 0
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/
│   ├── http-api.md      # Hono の API
│   └── domain-module.md # ドメイン層の関数とリポジトリのポート
├── checklists/
│   └── requirements.md
└── tasks.md             # /speckit-tasks で作成
```

### Source Code (repository root)

```text
package.json             # pnpm workspace のルート（scripts: dev, test, typecheck, lint）
pnpm-workspace.yaml
biome.json
tsconfig.base.json
AGENTS.md                # AIエージェント向けの作業指示

packages/
├── domain/              # 純粋な TypeScript。依存は schema のみ
│   ├── src/
│   │   ├── money.ts           # Yen、内税額の計算
│   │   ├── journal.ts         # validateJournal
│   │   ├── tax-settings.ts    # 消費税の設定の解決・検証
│   │   ├── opening.ts         # 期首残高の検証
│   │   ├── reports/           # trial-balance, general-ledger, pl, bs, csv, warnings
│   │   ├── seed/              # accounts.individual.ts, tax-categories.ts
│   │   ├── ports.ts           # LedgerRepository などのインターフェース
│   │   └── usecases/          # createJournal, correctJournal, voidJournal, closePeriod ...
│   └── test/
│       ├── arbitraries.ts     # fast-check のジェネレーター
│       ├── *.property.test.ts
│       └── *.test.ts
├── schema/              # Zod のスキーマ（API の入出力。web と server で共有）
│   └── src/
└── db/                  # Drizzle のスキーマ、マイグレーション、リポジトリの実装
    ├── src/
    │   ├── schema.ts
    │   ├── tenant-store.ts    # entityId → DB ファイルを開いて migrate
    │   ├── registry.ts
    │   └── ledger-repository.ts
    ├── drizzle/               # 生成された SQL ＋ 手書きの custom SQL（トリガー・ビュー）
    └── test/                  # テンポラリの SQLite での統合テスト

apps/
├── server/              # Hono。ルート → usecase の呼び出しだけ（ロジックを書かない）
│   ├── src/
│   │   ├── app.ts             # AppType を export
│   │   ├── routes/            # entities, masters, periods, journals, reports
│   │   └── main.ts            # 127.0.0.1 で待ち受け
│   └── test/                  # app.request() による API テスト
└── web/                 # Vite + React
    ├── src/
    │   ├── routes/            # TanStack Router（ファイルベース）
    │   ├── components/        # shadcn/ui
    │   ├── features/          # entities, accounts, journals, reports
    │   └── lib/api.ts         # hc<AppType>
    └── e2e/                   # Playwright

data/                    # 実行時のデータ（.gitignore）
```

**Structure Decision**: pnpm workspace の monorepo（R9）。依存の向きは `apps/* → packages/db → packages/domain → packages/schema` と `apps/web → packages/schema` の一方向とする。`packages/domain` は DB・HTTP・UI のライブラリを import しない（Biome の `noRestrictedImports` で強制）。

## Phase の進め方（tasks への入力）

1. **Setup**: PoC（R1 のゲート）→ monorepo の雛形、Biome、tsconfig、Vitest、CI（GitHub Actions: typecheck・lint・test）
2. **Foundational**: Zod スキーマ、ドメインの型と money、arbitraries、Drizzle スキーマ ＋ custom SQL、tenant-store・registry、リポジトリ
3. **US1**（事業体・マスタ・期首残高）→ **US2**（仕訳の入力）→ **US3**（訂正・取消・履歴・検索）→ **US4**（帳票）→ **US5**（締め）→ **US6**（事業体の切替）
4. 各ユーザーストーリーで「プロパティ／ユニットテスト → ドメイン → リポジトリ → API → 画面」の順
5. **Polish**: E2E、性能の確認（SC-003, SC-004）、AGENTS.md、quickstart の検証

## Complexity Tracking

違反なし。
