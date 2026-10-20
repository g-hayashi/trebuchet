# AGENTS.md

このリポジトリで作業するエージェント（および人間の開発者）向けの手順と規約。
個人事業主向けの会計アプリ（ローカル専用、Mac）。pnpm モノレポ。

## 構成と依存の向き

```
apps/web ──────────────→ packages/schema
apps/server ──→ packages/db ──→ packages/domain ──→ packages/schema
apps/server ──→ packages/domain
apps/server ──→ packages/schema
```

| パッケージ | 役割 | 制約 |
|---|---|---|
| `packages/schema` | Zod スキーマ（API と入力の形）、共有の定数 | 他のパッケージに依存しない |
| `packages/domain` | 業務ルール（仕訳の検証、締め、帳票、ユースケース） | **純粋関数のみ**。`node:fs` / `node:sqlite`、DB、Hono、React を import しない。Biome の `noRestrictedImports` で機械的に止める |
| `packages/db` | SQLite（better-sqlite3 + Drizzle）、マイグレーション、リポジトリ実装 | DB へのアクセスはここに閉じる |
| `apps/server` | Hono の API サーバー（`127.0.0.1:8787`） | HTTP の入出力と DI の組み立て。業務ルールは書かない |
| `apps/web` | React + Vite の画面（`127.0.0.1:5173`、`/api` は 8787 へ proxy） | 業務ルールを持たない。`@trebuchet/schema` に依存する |

- `packages/domain` の禁止は Biome が止めるのは次の import だけ: `hono`、`react`、`drizzle-orm`、`better-sqlite3`、`node:fs`、`node:sqlite`。`node:` の他のモジュールや `zod` の直接 import は Biome では止まらない。レビューで確認する。
- `packages/domain` は `@trebuchet/schema` に依存する。`schema` は Zod に依存する。
- `apps/web` は `@trebuchet/server` を devDependency に持つ。`hc<AppType>` のために型だけを import する（`import type`）。実行時のコードは参照しない。

## コマンド

| 目的 | コマンド |
|---|---|
| 開発サーバー（server 8787 と web 5173） | `pnpm dev` |
| 全テスト（Vitest の全プロジェクト） | `pnpm test` |
| 1 プロジェクトのテスト | `pnpm vitest run --project <domain\|db\|server\|web\|schema>` |
| 型チェック（全パッケージ + scripts） | `pnpm typecheck` |
| Lint（Biome） | `pnpm lint` |
| 整形（Biome で書き換え） | `pnpm format` |
| 性能計測（SC-004 の仕訳 2,000 件、003 の SC-006 の決算書） | `pnpm bench:reports` |
| 性能計測（freee 取込の 500 仕訳、002 の SC-002） | `pnpm bench:import` |
| freee の書き出しの確認と照合（実データ、ローカル専用） | `pnpm verify:freee`（`work/` を読む。使い方は `scripts/verify-freee-import.ts` の先頭のコメント） |
| 青色申告決算書の照合（実データ、ローカル専用） | `pnpm verify:tax-return`（`work/` を読む。使い方は `scripts/verify-tax-return.ts` の先頭のコメント） |
| E2E（Playwright、Chromium） | `pnpm --filter @trebuchet/web e2e` |
| web のビルド（`routeTree.gen.ts` を再生成する） | `pnpm --filter @trebuchet/web build` |

- CI（`.github/workflows/ci.yml`）は `pnpm typecheck`、`pnpm lint`、`pnpm test` を実行する。E2E、bench、`verify:freee`、`verify:tax-return` は CI に含まれない。
- 変更を終える前に、少なくとも `pnpm typecheck`、`pnpm lint`、`pnpm test` を通す。

## 開発の進め方

- **テストを先に書く（TDD）**（Constitution V）。失敗するテストを確認してから実装する。
- **不変条件（INV-1〜INV-10）**は `specs/001-ledger-core/data-model.md` §4 にある。対応するテストは fast-check の性質テストで書く。`fc.assert(fc.property(...))` を直接呼ぶ（`@fast-check/vitest` は使わない。research R6）。
- **web のテストはコンポーネントテスト**（Testing Library + jsdom）。テストのためだけに node 専用のロジックを別ファイルに切り出さない。
- **Node 26 の型の除去で直接実行する**（`tsx` は使わない）。次を守る:
  - 相対 import は `.ts` を付ける（`allowImportingTsExtensions`）
  - `enum`、パラメーター・プロパティ、`namespace` を使わない（`erasableSyntaxOnly`）
  - 型だけの import は `import type` と書く（`verbatimModuleSyntax`）
- **マイグレーションの再生成**: `drizzle-kit generate` は `STRICT` を出力しない。生成後、`0000_init.sql` の `);` を `) STRICT;` に置き換える（research R2 / T024）。再生成のたびに同じ置き換えが必要。`tenant-store` のテストが `STRICT` を確認する。
- **トリガー・ビュー**は `drizzle-kit generate --custom` で手書きの SQL として追加する（research R2）。

## freee の取込（002）

取込の実装は次に置く。

| 層 | 場所 |
|---|---|
| CSV の解析、freee 形式の読み取り、対応表、決算振替の判定、期首残高の案、照合、取込の計画 | `packages/domain/src/import/`（`csv.ts`、`freee/` の `columns.ts`、`read.ts`、`mapping.ts`、`closing.ts`、`opening.ts`、`reconcile.ts`、`plan.ts`） |
| ユースケース | `packages/domain/src/usecases/import-freee.ts` |
| 永続化（取込のトランザクション、取消） | `packages/db/src/import-repository.ts` |
| HTTP | `apps/server/src/routes/imports.ts` |
| 画面 | `apps/web/src/features/imports/`、`apps/web/src/routes/e/$entityId/imports/` |

- 実データ（`work/`）を読むのは `scripts/verify-freee-import.ts`（`pnpm verify:freee`）と `scripts/verify-tax-return.ts`（`pnpm verify:tax-return`）だけ。取込の共通部分は `scripts/lib/freee-import-runner.ts`。出力（件数、科目別の金額など）はコミットしない。ドキュメントや `tasks.md` にも実データの数値を書かない。
- テストのフィクスチャは `packages/domain/test/fixtures/freee/` の **合成の** CSV。作り方と匿名化の方針は同じ場所の `README.md` に書いてある。CSV の生成スクリプトはリポジトリに置かない（使い捨て）。手で直す場合は、全項目をクォートし、LF で終える。元帳は UTF-8 の元（`ledger-2025.utf8.csv`）から CP932 の `ledger-2025.csv` を `iconv` で作る。フィクスチャを変えたら README の「検算」をして `expected.ts` を直す。
- 取込のプロパティテスト（INV-14, 16, 17）は `packages/domain/test/freee-arbitraries.ts` のジェネレーターで、貸借一致の仕訳から freee 形式の仕訳帳と元帳を作って検証する。
- 年初付の決算振替は仕訳として取り込まず、期首残高に繰り込む（[ADR 0004](docs/adr/0004-freee-closing-entries.md)）。

## 決算書（003）

青色申告決算書（一般用、個人の事業体だけ）の実装は次に置く。

| 層 | 場所 |
|---|---|
| 決算書の組み立て（様式、按分、減価償却、控除の判定、月別売上と売上先、期首の貸借対照表の検査、CSV） | `packages/domain/src/blue-return/`（`form.ts`、`build.ts`、`home-use.ts`、`depreciation.ts`、`deduction.ts`、`sales.ts`、`balance-sheet.ts`、`opening-check.ts`、`tax-parameters.ts`、`csv.ts`） |
| ユースケース | `packages/domain/src/usecases/blue-return.ts` |
| 永続化（按分・資産・控除の回答・メモ・控えの保存、決算整理の仕訳との結びつけ） | `packages/db/src/closing-repository.ts` |
| HTTP | `apps/server/src/routes/blue-return.ts`、`fixed-assets.ts`、`tax-return.ts` |
| 画面 | `apps/web/src/features/blue-return/`、`fixed-assets/`、`tax-return/`、`apps/web/src/routes/e/$entityId/` の `blue-return/`・`fixed-assets/`・`tax-return/` |

- 按分と少額減価償却は、決算整理の「仕訳」として登録する。ドメインが案を作り、利用者が確かめて 001 の `createJournal` で登録する（[ADR 0005](docs/adr/0005-closing-adjustments-as-journals.md)）。決算書は帳簿の損益計算書・貸借対照表と一致する。
- **税制の値の足し方**（基準額、控除額など。Constitution VI）: 次の**両方**に、適用の期間つきの行を足す。出典の URL は必須（国税庁・財務省などの一次資料）。
  1. `packages/domain/src/seed/tax-parameters.ts`（正本）
  2. マイグレーション。`pnpm --filter @trebuchet/db exec drizzle-kit generate --custom --config drizzle.tenant.config.ts` で空の SQL を作り、`INSERT` を手で書く（既存の行は書き換えず、適用の終了日を足すか新しい行を足す）。`packages/db/test/closing-repository.test.ts`（`listTaxParameters`）が、seed とマイグレーションで投入された値の一致を確かめる
  - 新しい `key` を足すときは、`tax_parameters` の CHECK 制約（`key IN (...)`）と型 `TaxParameter` の `key` も直す。
- 様式の値（欄番号、行の定義）は `packages/domain/src/blue-return/form.ts` に置き、国税庁の様式の原本と照らして確かめる（research R2）。
- 性能は `pnpm bench:reports` が SC-006（約 500 仕訳で決算書の画面が使う API が 2 秒以内）も確かめる。
- 実データでの照合は `pnpm verify:tax-return`（`--closing` の JSON の形はスクリプトの先頭のコメント）。出力は欄の識別子と一致・不一致の件数だけで、金額・取引先名・按分率は出さない。

## データと一時ファイル

- **実データを読まない、コミットしない**。`work/` と `data/` は実データを含む。中身を開く・要約する・テストの入力にする・コミットすることをしない。`.gitignore` で除外済み。
- 既定のデータ位置はリポジトリ直下の `data/`。`TREBUCHET_DATA_DIR` で変更できる。テストでは実データに触れないよう、一時のデータ場所を使う。
- **一時ファイルは `.tmp/` の下だけに作る**（`/tmp` や `os.tmpdir()` は使わない）。`packages/db/src/testing.ts` の `useTempDataDir` を使う。E2E と bench も `.tmp/` を使う。

## 仕様と文書

- Spec Kit の成果物は `specs/<feature>/`（`specs/001-ledger-core/`、`specs/002-freee-import/`、`specs/003-tax-return/`）に置く: `spec.md`、`plan.md`、`research.md`、`data-model.md`、`quickstart.md`、`tasks.md`。
- Spec Kit のテンプレート、スクリプト、憲法（`.specify/memory/constitution.md`）は `.specify/` に置く。
- Spec Kit のスキルは、Claude Code 用が `.claude/skills/speckit-*`、GitHub Copilot CLI 用が `.github/skills/speckit-*` にある。両方の統合を入れてあり、既定は claude。どちらも `uvx --from git+https://github.com/github/spec-kit.git@v1.2.1 specify integration upgrade <claude|copilot>` で更新する（手で片方だけを直さない）。
- Claude Code は、CLAUDE.md がないときにこの AGENTS.md を読む。リポジトリに CLAUDE.md を作らない（作る場合は `@AGENTS.md` を取り込む）。`work/` と `data/` の読み取りは `.claude/settings.json` で拒否している。
- 設計判断は `docs/adr/` に ADR として書く（`NNNN-短い名前.md`、番号は連番）。書式は `docs/adr/0001-sqlite-driver.md` に合わせる。
- AGENTS.md は憲法と矛盾させない。
- コミットメッセージは Conventional Commits に従う。

## 参照

- 仕様: `specs/001-ledger-core/spec.md`
- 設計: `specs/001-ledger-core/plan.md`、`data-model.md`、`research.md`
- 手順: `specs/001-ledger-core/quickstart.md`
- 憲法: `.specify/memory/constitution.md`
- ADR: `docs/adr/`
