---

description: "Task list for 001-ledger-core"
---

# Tasks: 帳簿コア（事業体・勘定科目・仕訳・帳票）

**Input**: Design documents from `specs/001-ledger-core/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: 必須。Constitution V（テストファースト）により、各ユーザーストーリーでテストを先に書き、**失敗することを確認してから**実装する。不変条件 INV-1〜10（data-model §4）は fast-check のプロパティテストで検証する。

**Organization**: ユーザーストーリーごとにまとめ、ストーリー単位で実装・検証できるようにする。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 並列に実行できる（別ファイルで、未完了のタスクに依存しない）
- **[Story]**: 対応するユーザーストーリー（US1〜US6）

## 全タスク共通のルール

- パッケージ名: `@trebuchet/schema`, `@trebuchet/domain`, `@trebuchet/db`, `@trebuchet/server`, `@trebuchet/web`
- 依存の向き: `apps/* → packages/db → packages/domain → packages/schema`、`apps/web → packages/schema`。`packages/domain` は hono・react・drizzle-orm・better-sqlite3・`node:fs`・`node:sqlite` を import しない
- 金額は `number` の整数（`0 < amount < 1e12`）。浮動小数の演算をしない
- ID は `import { randomUUIDv7 } from "node:crypto"`（グローバルの `crypto` にはない。T001 で確認）。ドメイン層では直接呼ばず、`IdGenerator` ポートから受け取る（純関数を保つため）
- **テストの一時ファイルはプロジェクト内の `.tmp/`（`.gitignore` 済み）に作る。`/tmp`・`os.tmpdir()`・プロジェクト外のパスは使わない**（利用者の指示）
- 実データ（`work/`）をテストやフィクスチャに使わない。フィクスチャは合成データ
- コミットメッセージは Conventional Commits。末尾に `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`

---

## Phase 1: Setup（共通の基盤）

**Purpose**: SQLite ドライバーの検証と monorepo の雛形

- [X] T001 SQLite ドライバーの PoC（research.md R1 のゲート）を `.poc/sqlite/` で実施する。`.poc/` は `.gitignore` 済み。**`pnpm add` の前に利用者の承認を得る**。確認する項目: (1) Node 26 で `better-sqlite3@13` がインストールできる（ビルド済みバイナリか、ローカルビルドか）、(2) `CREATE TABLE ... STRICT` が使える、(3) `BEFORE DELETE` トリガーの `RAISE(ABORT, ...)` で削除が拒否される、(4) `drizzle-orm/better-sqlite3` で接続し、同期トランザクションが使える、(5) `crypto.randomUUIDv7()` が使える。結果を `specs/001-ledger-core/research.md` の R1 に「PoC 結果（日付）」として追記し、`docs/adr/0001-sqlite-driver.md` にも決定を記録する。あわせて、`tsx` を使わずに `node --watch` で TypeScript を直接実行できるかを確認し、できれば T009 から `tsx` を外す（Constitution VII）。失敗した場合は R1 の Decision を `node:sqlite` に変更し、以降のタスクのドライバー名を読み替える
- [X] T002 ルートの `package.json`（`"private": true`, `"type": "module"`, `"engines": { "node": ">=26.5.1" }`, `"packageManager": "pnpm@<最新>"`, scripts: `dev`, `test`, `typecheck`, `lint`, `format`, `bench:reports`）と `pnpm-workspace.yaml`（`apps/*`, `packages/*`）、`.nvmrc`（`26`）を作成する
- [X] T003 [P] `tsconfig.base.json` を作成する（TypeScript 7.0、`strict: true`, `module`/`moduleResolution: "NodeNext"`、`verbatimModuleSyntax: true`、`noUncheckedIndexedAccess: true`、`exactOptionalPropertyTypes: true`）
- [X] T004 [P] `biome.json` を作成する（lint と format を有効化）。`packages/domain/**` に対して `noRestrictedImports` で `hono`, `react`, `drizzle-orm`, `better-sqlite3`, `node:fs`, `node:sqlite` を禁止する
- [X] T005 [P] `.gitignore` に `.tmp/`, `dist/`, `coverage/`, `playwright-report/`, `test-results/` を追記する
- [X] T006 [P] `packages/schema` の雛形を作成する（`package.json` の name `@trebuchet/schema`、依存 `zod@4`、`tsconfig.json`、`src/index.ts`）
- [X] T007 [P] `packages/domain` の雛形を作成する（name `@trebuchet/domain`、依存 `@trebuchet/schema`、devDeps `vitest@5`, `fast-check@4`、`exports` に `"."` と `"./testing"`（`test/arbitraries.ts` などのテスト用ヘルパーを他パッケージのテストに公開）、`vitest.config.ts`）
- [X] T008 [P] `packages/db` の雛形を作成する（name `@trebuchet/db`、依存 `drizzle-orm@0.45`, `better-sqlite3@13`、devDeps `drizzle-kit@0.31`, `@types/better-sqlite3`、`drizzle.tenant.config.ts` と `drizzle.registry.config.ts`（drizzle-kit は1ファイル1出力のため分割。出力先 `packages/db/drizzle/tenant` と `packages/db/drizzle/registry` の2系統）、`vitest.config.ts`）
- [X] T009 [P] `apps/server` の雛形を作成する（name `@trebuchet/server`、依存 `hono@4`, `@hono/node-server@>=2.1.3`, `@hono/standard-validator`, `@trebuchet/db`, `@trebuchet/domain`, `@trebuchet/schema`、`vitest.config.ts`。`tsx` は使わず、dev は `node --watch src/main.ts`（T001 で確認））
- [X] T010 [P] `apps/web` の雛形を Vite 8 ＋ React 19 で作成する（name `@trebuchet/web`、TanStack Router のファイルベースルーティングの Vite プラグイン、TanStack Query、TanStack Table、react-hook-form ＋ `@hookform/resolvers`、Tailwind CSS 4、`shadcn` の初期化、`vite.config.ts` で `/api` を `http://127.0.0.1:8787` にプロキシ、dev サーバーは `127.0.0.1:5173`）
- [X] T011 [P] ルートの `vitest.config.ts` で各パッケージを projects としてまとめ、`pnpm test` で全体を実行できるようにする
- [X] T012 [P] `.github/workflows/ci.yml` を作成する（Node 26、pnpm、`pnpm install --frozen-lockfile` → `pnpm typecheck` → `pnpm lint` → `pnpm test`）
- [X] T013 空の雛形で `pnpm install && pnpm typecheck && pnpm lint && pnpm test` が成功することを確認し、コミットする

---

## Phase 2: Foundational（全ストーリーの前提）

**Purpose**: 型、DB スキーマ、テナントの分離、API の骨組み

**⚠️ CRITICAL**: このフェーズが終わるまで、ユーザーストーリーの作業を始めない

### 共有スキーマとドメインの型

- [X] T014 [P] `packages/schema/src/primitives.ts` を作成する: `Yen = z.number().int().positive().lt(1e12)`、`DateString`（`YYYY-MM-DD` で実在する日付）、`Id`（UUID）、`Side = "debit" | "credit"`、`TaxCategoryCode = "OUT_OF_SCOPE" | "SALES_10" | "SALES_8R" | "PURCHASE_10" | "PURCHASE_8R" | "EXEMPT" | "NON_TAXABLE"`、`AccountCategory = "asset" | "liability" | "equity" | "revenue" | "expense"`、`ReportSection = "PL_SALES" | "PL_COGS" | "PL_EXPENSE" | "PL_OTHER" | "BS_ASSET" | "BS_LIABILITY" | "BS_EQUITY"`、`EntityKind = "individual" | "corporation"`、`TaxpayerStatus = "exempt" | "general" | "simplified" | "two_tenths"`、`AccountingMethod = "tax_included" | "tax_excluded"`
- [X] T015 [P] `packages/schema/src/errors.ts` を作成する: エラーコード `VALIDATION`, `UNBALANCED`, `ACCOUNT_INACTIVE`, `ACCOUNT_NOT_FOUND`, `OUT_OF_PERIOD`, `PERIOD_CLOSED`, `REASON_REQUIRED`, `VERSION_CONFLICT`, `ACCOUNT_IN_USE`, `TAX_SETTING_GAP`, `TAX_METHOD_UNSUPPORTED`, `ENTITY_NOT_FOUND`、エラーレスポンス `{ error: { code, message, details? } }`、警告コード `POSSIBLE_DUPLICATE`, `NEGATIVE_BALANCE`, `OPENING_BALANCE_MISSING`（contracts/http-api.md のエラー形式）
- [X] T016 [P] `packages/domain/test/money.property.test.ts` を書く（INV-10）: 任意の `amount`（1〜1e12-1）と `rate ∈ {8, 10}` で `computeInclusiveTax(amount, rate) === Math.floor(amount * rate / (100 + rate))`、`0 <= tax < amount`、結果が安全な整数。`sumYen` が結合的で、安全な整数に収まる
- [X] T017 `packages/domain/src/money.ts` を実装する: ブランド型 `Yen`、`toYen(n): Result<Yen>`、`computeInclusiveTax(amount, rate)`、`sumYen(values)`。T016 が通ること
- [X] T018 [P] `packages/domain/src/types.ts` を作成する: `Result<T, E>`、`Account`, `SubAccount`, `Partner`, `Tag`, `FiscalPeriod`（`status: "open" | "closed"`）, `TaxSetting`, `TaxCategory`, `OpeningBalance`, `LineDraft`, `JournalDraft`, `ValidJournal`, `Journal`（`status: "active" | "voided"`, `version`, `correctsJournalId`）, `JournalLine`, `PostedLine`, `AuditEntry`（`targetType`, `action`, `reason`, `beforeJson`, `afterJson`）, `JournalQuery`, `Page<T>`, `DomainError`（`code` は T015 と同じ集合 ＋ `details`）
- [X] T019 `packages/domain/src/ports.ts` を作成する: `LedgerRepository`（contracts/domain-module.md のとおり ＋ `lastJournal(): Journal | undefined`, `getJournal(id)`, `journalHistory(id)`, `correctingJournalsOf(id)`）、`MasterRepository`（科目・補助科目・取引先・タグ・消費税の設定・会計期間・期首残高の取得と保存、`isAccountUsed(accountId)`）、`RegistryRepository`（事業体の一覧・作成・名称変更）、`IdGenerator`（`next(): string`）、`Clock`（`now(): string`, ISO 8601 UTC）
- [X] T020 [P] `packages/domain/test/arbitraries.ts` を作成し、`@trebuchet/domain/testing` として公開する: 科目セット（各区分を1つ以上）、貸借が一致する仕訳（2〜8行、借方・貸方とも1行以上、金額は 1〜1e9）、貸借が一致する期首残高、会計期間内の日付、取消フラグ付きの仕訳列

### DB スキーマとマイグレーション

- [X] T021 `packages/db/src/schema/tenant.ts` にマスタのテーブルを Drizzle で定義する（data-model §2 のとおり）: `entity_profile`（`fiscal_start_month` 1〜12）、`fiscal_periods`（`fiscal_year` UNIQUE、`status` は `open` | `closed`、`closed_at` NULL 可）、`accounts`（`code` UNIQUE、`name` NOT NULL UNIQUE、`category`, `normal_side`, `report_section`, `report_line` NULL 可, `sort_order`, `is_system`, `is_active`）、`sub_accounts`（`account_id` FK、`(account_id, name)` UNIQUE）、`partners`（`name` NOT NULL UNIQUE、`honorific` は `様` | `御中` | NULL）、`tags`（`name` UNIQUE）、`tax_categories`（`code` PK, `name`, `kind`）、`tax_rates`（`category_code`, `rate` INTEGER, `effective_from`, `source_url` NOT NULL、`(category_code, effective_from)` UNIQUE）、`consumption_tax_settings`（`effective_from` UNIQUE）
- [X] T022 `packages/db/src/schema/tenant.ts` に残高・仕訳・監査のテーブルを追加する（data-model §3, §5）: `opening_balances`（`amount` > 0、`(fiscal_period_id, account_id, sub_account_id)` UNIQUE）、`journals`（`journal_no` UNIQUE、`status` は `active` | `voided`、`corrects_journal_id` FK → journals NULL 可、`source` 既定 `manual`、`version` 既定 1）、`journal_lines`（`CHECK (amount > 0 AND amount < 1000000000000)`、`tax_amount` >= 0、`(journal_id, line_no)` UNIQUE）、`journal_line_tags`（複合 PK）、`audit_log`（`target_type` は `journal` | `account` | `fiscal_period` | `opening_balance` | `tax_setting`、`action` は `create` | `correct` | `void` | `rename` | `deactivate` | `close` | `reopen` | `replace`）
- [X] T023 [P] `packages/db/src/schema/registry.ts` に `entities`（`id` PK, `name`, `kind`, `db_file`, `created_at`）を定義する
- [X] T024 `drizzle-kit generate` で `packages/db/drizzle/tenant/` と `packages/db/drizzle/registry/` に SQL を生成する。生成された `CREATE TABLE` に `STRICT` を付ける（Drizzle が出力しないため、生成後の SQL を編集する。編集できない場合は research.md R2 に理由を記録する）
- [X] T025 `drizzle-kit generate --custom` でテナント用の手書きマイグレーション `packages/db/drizzle/tenant/<番号>_integrity.sql` を作成する: トリガー `journals_no_delete`（`BEFORE DELETE ON journals` → `RAISE(ABORT, 'journals cannot be deleted')`）、`audit_log_no_update`、`audit_log_no_delete`、ビュー `v_unbalanced_journals`（有効な仕訳で Σ借方 ≠ Σ貸方 のもの）、インデックス `journals(date)`, `journal_lines(account_id)`, `journal_lines(partner_id)`、`tax_categories` の7行と `tax_rates` の4行（10%・8%、`effective_from = 2019-10-01`、出典 URL つき）の投入（data-model §2 の表）
- [X] T026 [P] `packages/db/test/integrity.test.ts` を書く（`.tmp/` の一時 DB）: journals の DELETE が失敗する、audit_log の UPDATE・DELETE が失敗する（INV-9）、`amount = 0` と `amount = 1e12` の行が CHECK で失敗する（INV-3）、`PRAGMA foreign_keys` が ON、`v_unbalanced_journals` が貸借不一致の仕訳を検出する
- [X] T027 `packages/db/src/tenant-store.ts` を実装する: `openTenant(entityId)` は `entityId` を UUID の正規表現で検証（パストラバーサル防止）し、`${TREBUCHET_DATA_DIR ?? "./data"}/tenants/<entityId>.sqlite` を開き、`PRAGMA foreign_keys = ON`, `journal_mode = WAL` を設定して `migrate()` を実行する。開いたハンドルはキャッシュする。`openRegistry()` も同様
- [X] T028 [P] `packages/db/src/testing.ts` にテスト用ヘルパーを作成する: `.tmp/<uuid>/` を `TREBUCHET_DATA_DIR` にして DB を開き、終了時に削除する
- [X] T029 `packages/db/test/tenant-store.test.ts` を書く: 新しい entityId で DB ファイルが作られマイグレーションが適用される、不正な entityId（`../x` など）は拒否される、同じ entityId は同じハンドルを返す

### API とフロントの骨組み

- [X] T030 `apps/server/src/errors.ts` を作成する: `DomainError` を HTTP に変換する（contracts/http-api.md の表: 400 `VALIDATION`、422 `UNBALANCED`/`ACCOUNT_INACTIVE`/`ACCOUNT_NOT_FOUND`/`OUT_OF_PERIOD`/`REASON_REQUIRED`/`TAX_SETTING_GAP`/`TAX_METHOD_UNSUPPORTED`、409 `PERIOD_CLOSED`/`VERSION_CONFLICT`/`ACCOUNT_IN_USE`、404 `ENTITY_NOT_FOUND`）。Zod のエラーは 400 `VALIDATION` にする
- [X] T031 `apps/server/src/app.ts` を作成する: `new Hono().basePath("/api")`、`app.onError` で T030 を使う、`/entities/:entityId/*` のミドルウェアで registry に事業体があるか確認して `openTenant` し、DB のハンドルを `c.var.db` に入れる（リポジトリは US1 以降で `c.var.db` から生成する）（なければ 404 `ENTITY_NOT_FOUND`）。ルートはメソッドチェーンで定義し、`export type AppType` を出す
- [X] T032 `apps/server/src/main.ts` を作成する: `@hono/node-server` の `serve` で `hostname: "127.0.0.1"`, `port: 8787` で待ち受ける（R13）。ルートの `pnpm dev` で server と web を同時に起動する
- [X] T033 [P] `apps/server/test/tenant-middleware.test.ts` を書く（`app.request()`）: 存在しない entityId は 404 `ENTITY_NOT_FOUND`、不正な形式の entityId も 404
- [X] T034 [P] `apps/web/src/lib/api.ts` を作成する: `hc<AppType>("/")`（basePath が `/api` を含むため `api.api...` で呼ぶ）、エラーレスポンスを `ApiError`（code, message, details）に変換するヘルパー、`QueryClient`
- [X] T035 `apps/web/src/routes/__root.tsx` と `apps/web/src/routes/e/$entityId/route.tsx` を作成する: 共通レイアウト（ヘッダー、ナビゲーション: 仕訳・帳票・マスタ・会計期間。TanStack Router の `Link` は存在するルートしか指定できないため、各項目は該当する画面のタスクで追加する）、`entityId` はパスのパラメータから取得する

**Checkpoint**: 基盤が完成。ユーザーストーリーの実装を始められる

---

## Phase 3: User Story 1 - 事業体を作成して帳簿を開始する (Priority: P1) 🎯 MVP

**Goal**: 事業体を作成すると、勘定科目の初期セット・会計期間・消費税の設定が用意され、マスタと期首残高を登録できる

**Independent Test**: 事業体を作成し、勘定科目の一覧（決算書の順）と期首残高が表示され、貸借が合わない期首残高は保存できない

### Tests for User Story 1 ⚠️

> **NOTE: 先に書き、失敗することを確認してから実装する**

- [X] T036 [P] [US1] `packages/domain/test/seed-accounts.test.ts` を書く: 科目コードと科目名が重複しない、各科目の `normal_side` が区分と整合する（資産・費用は debit、負債・純資産・収益は credit。事業主貸は例外として debit）、data-model §2 の初期セットの科目がすべて含まれる、経費の `report_line` が 8〜31 の範囲で、地代家賃が 23（過去の決算書で確認。24 は貸倒金）
- [X] T037 [P] [US1] `packages/domain/test/tax-settings.property.test.ts` を書く（FR-009）: `validateTaxSettings` は `effective_from` の重複を `TAX_SETTING_GAP` で拒否する、最初の行の `effective_from` が最初の会計期間の開始日より後なら拒否する、`exempt` で `tax_excluded` なら拒否する。`resolveTaxSetting(date)` は `effective_from <= date` のうち最新の設定を返す（任意の設定列と日付でオラクルと一致）
- [X] T038 [P] [US1] `packages/domain/test/opening.property.test.ts` を書く（FR-011）: `validateOpeningBalances` は Σ借方 = Σ貸方 のときだけ成功し、失敗時は `UNBALANCED` で `details: { debit, credit, diff }` を返す。金額 0 以下と、同じ (科目, 補助科目) の重複を拒否する
- [X] T039 [P] [US1] `packages/domain/test/create-entity.test.ts` を書く（フェイクのリポジトリ）: `createEntity({ name: "個人事業", kind: "individual", fiscalStartMonth: 1, firstFiscalYear: 2026 })` で、初期の科目セット、2026-01-01〜2026-12-31 の会計期間（`open`）、`effective_from = 2026-01-01` の `exempt`・`tax_included` の設定が作られる。`kind: "corporation"` でも個人用の初期セットで作られる
- [X] T040 [P] [US1] `packages/domain/test/masters.test.ts` を書く: 仕訳で使われた科目の削除は `ACCOUNT_IN_USE`、使用停止は可能、科目名の変更は audit_log に `rename`（変更前・後の名前）を残す、使用停止は `deactivate` を残す、利用者が追加した科目のコードは自動採番される、補助科目は同じ科目内で名前が重複しない
- [X] T041 [P] [US1] `packages/db/test/master-repository.test.ts` を書く: 科目・補助科目・取引先・タグ・消費税の設定・会計期間・期首残高の保存と取得、期首残高の一括置換が1トランザクションで行われる
- [X] T042 [P] [US1] `apps/server/test/entities.api.test.ts` と `apps/server/test/masters.api.test.ts` を書く: `POST /api/entities` → 201 で初期データが入る、`GET /entities/:id/accounts` が `sort_order` 順、`PUT tax-settings` の重複 → 422 `TAX_SETTING_GAP`、`PUT opening-balances` の貸借不一致 → 422 `UNBALANCED`、使用中の科目の `DELETE` → 409 `ACCOUNT_IN_USE`、`PATCH /entities/:id` で名称を変更できる

### Implementation for User Story 1

- [X] T043 [P] [US1] `packages/domain/src/seed/accounts.individual.ts` を実装する（data-model §2 の初期セット、R10。青色申告決算書（一般用）の欄番号と科目順を持つ）。T036 が通ること
- [X] T044 [P] [US1] `packages/domain/src/seed/tax-categories.ts`（7つの税区分と `kind`）と `packages/domain/src/seed/tax-rates.ts`（data-model §2 の `tax_rates` の初期データ。各行に `sourceUrl`）を実装し、`packages/domain/src/tax-rates.ts` に `resolveTaxRate(categoryCode, date, rates)`（`effective_from <= date` のうち最新の税率。課税の区分以外は `undefined`）を実装する。DB への投入（T025）と同じ値であること、`source_url` が空でないことをテストで確認する
- [X] T045 [P] [US1] `packages/domain/src/tax-settings.ts` に `validateTaxSettings` と `resolveTaxSetting` を実装する。T037 が通ること
- [X] T046 [P] [US1] `packages/domain/src/opening.ts` に `validateOpeningBalances` を実装する。T038 が通ること
- [X] T047 [P] [US1] `packages/schema/src/entities.ts` と `packages/schema/src/masters.ts` を作成する: `EntityCreate { name: string(1..100), kind, fiscalStartMonth: int 1..12, firstFiscalYear: int 2000..2100 }`、`EntityPatch { name }`、`AccountCreate { name, category, reportSection, reportLine? }`、`AccountPatch { name?, isActive? }`、`SubAccountCreate { name }`、`PartnerInput { name, honorific: "様" | "御中" | null, memo? }`、`TagCreate { name }`、`TaxSettingsPut = Array<{ effectiveFrom, taxpayerStatus, accountingMethod }>`、`OpeningBalancesPut = Array<{ accountId, subAccountId?, side, amount: Yen }>`
- [X] T048 [US1] `packages/domain/src/usecases/create-entity.ts` を実装する: `テナントの `MasterRepository` に `entity_profile`、初期の科目、会計期間、消費税の設定（`exempt`・`tax_included`, 適用開始日 = 会計期間の開始日）を1トランザクションで投入し、最後に `RegistryRepository` に登録する（U2: テナントの失敗時は registry に何も残らない。registry の失敗時に残るテナントのファイルは一覧に出ず到達できない）。T039 が通ること
- [X] T049 [US1] `packages/domain/src/usecases/masters.ts` を実装する: `addAccount`, `renameAccount`（audit `rename`）, `setAccountActive`（audit `deactivate`）, `deleteAccount`（使用中なら `ACCOUNT_IN_USE`）, `addSubAccount`, `upsertPartner`, `addTag`, `replaceTaxSettings`（検証後に audit `replace`）, `createNextFiscalPeriod`（最後の期間の翌日から1年）, `replaceOpeningBalances`（検証後に audit `replace`。締め済みの期間なら `PERIOD_CLOSED`）。T040 が通ること
- [X] T050 [US1] `packages/db/src/registry-repository.ts` と `packages/db/src/master-repository.ts` を実装する（`RegistryRepository`, `MasterRepository` のポート）。T041 が通ること
- [X] T051 [US1] `apps/server/src/routes/entities.ts` を実装する: `GET /entities`, `POST /entities`, `PATCH /entities/:entityId`
- [X] T052 [US1] `apps/server/src/routes/masters.ts` を実装する: accounts（GET/POST/PATCH/DELETE）、sub-accounts（GET/POST）、partners（GET/POST/PATCH）、tags（GET/POST）、tax-categories（GET）、tax-settings（GET/PUT）
- [X] T053 [US1] `apps/server/src/routes/periods.ts` を実装する: `GET/POST /fiscal-periods`、`GET/PUT /fiscal-periods/:year/opening-balances`。T042 が通ること
- [ ] T054 [P] [US1] `apps/web/src/routes/index.tsx` に事業体の一覧と作成フォームを実装する（React Hook Form ＋ Zod。作成後に `/e/$entityId` へ移動）
- [ ] T055 [P] [US1] `apps/web/src/routes/e/$entityId/accounts.tsx` に勘定科目の画面を実装する（決算書の順の一覧、追加、名称変更、使用停止、補助科目の追加。使用停止の科目は薄く表示）
- [ ] T056 [P] [US1] `apps/web/src/routes/e/$entityId/partners.tsx` と `apps/web/src/routes/e/$entityId/tags.tsx` を実装する
- [ ] T057 [P] [US1] `apps/web/src/routes/e/$entityId/tax-settings.tsx` を実装する（期間の一覧と追加。保存時の `TAX_SETTING_GAP` をフォームに表示）
- [ ] T058 [P] [US1] `apps/web/src/routes/e/$entityId/periods/index.tsx` と `apps/web/src/routes/e/$entityId/periods/$year/opening-balances.tsx` を実装する（期間の一覧、翌年度の作成、期首残高の入力。借方合計・貸方合計・差額を常に表示し、一致しないと保存ボタンを無効にする）

**Checkpoint**: 事業体を作成し、マスタと期首残高を登録できる

---

## Phase 4: User Story 2 - 仕訳を手動で入力する (Priority: P1)

**Goal**: 単一行・複合の仕訳を登録でき、不正な仕訳は理由とともに拒否される

**Independent Test**: 単一行と複合の仕訳が仕訳番号つきで登録され、貸借不一致の仕訳が差額つきで拒否される

### Tests for User Story 2 ⚠️

- [ ] T059 [P] [US2] `packages/domain/test/journal.property.test.ts` を書く（`validateJournal`）: INV-1（arbitraries の任意の仕訳は成功し、1行の金額をずらすと `UNBALANCED` で `details.diff` が差額）、INV-2（借方のみ・貸方のみは拒否）、INV-3（0 以下・1e12 以上・非整数は拒否）、存在しない科目は `ACCOUNT_NOT_FOUND`、使用停止の科目は `ACCOUNT_INACTIVE`、補助科目が別の科目に属していれば拒否、会計期間のない日付は `OUT_OF_PERIOD`、締め済みの期間の日付は `PERIOD_CLOSED`、消費税の設定が `tax_excluded` の期間の日付は `TAX_METHOD_UNSUPPORTED`。複数の違反はすべて返す
- [ ] T060 [P] [US2] `packages/domain/test/tax-default.test.ts` を書く（FR-017）: 免税期間の既定の税区分は `OUT_OF_SCOPE`、課税・税込の期間で売上の科目は `SALES_10`、費用の科目は `PURCHASE_10`、資産・負債・純資産の科目は `OUT_OF_SCOPE`。税込経理で課税の税区分の行は `tax_amount = computeInclusiveTax(amount, resolveTaxRate(taxCategory, date, rates))`、それ以外は 0。税率のデータに適用開始日の異なる2行を用意し、仕訳の日付によって使われる税率が切り替わることを確認する（Constitution VI）
- [ ] T061 [P] [US2] `packages/domain/test/create-journal.test.ts` を書く（フェイクのリポジトリ）: 仕訳番号は 1 から登録順に増える（INV-8）、audit_log に `create` が1件追記される、直前の仕訳と日付・科目・金額の組が同じなら `warnings: [{ code: "POSSIBLE_DUPLICATE" }]` を返すが登録はされる（FR-018）、検証エラーのときは何も書き込まない
- [ ] T062 [P] [US2] `packages/db/test/ledger-repository.test.ts` を書く: 仕訳・行・タグの保存と取得、`nextJournalNo` がトランザクション内で採番される、arbitraries の仕訳を 1,000 件登録しても `v_unbalanced_journals` が空、トランザクション内で例外が起きたら仕訳も audit_log も残らない
- [ ] T063 [P] [US2] `apps/server/test/journals.create.api.test.ts` を書く: 受け入れシナリオ US2-1（`売掛金 495,000 / 売上高 495,000` → 201 と `journalNo`）、US2-2（`普通預金 487,037 ＋ 事業主貸 7,963 / 売掛金 495,000`）、US2-3（借方 500,000 / 貸方 495,000 → 422 `UNBALANCED` で `diff: 5000`）、US2-4（金額 0 → 400 `VALIDATION`、会計期間外 → 422 `OUT_OF_PERIOD`）、`GET /journals/:id` で行が返る

### Implementation for User Story 2

- [ ] T064 [P] [US2] `packages/schema/src/journals.ts` に `JournalInput` を作成する（contracts/http-api.md のとおり。`lines` は 2 行以上で、`refine` で借方・貸方を1行以上ずつ要求。`amount` は `Yen`、`tagIds` の重複は不可）と、レスポンスの `JournalOutput`（`id`, `journalNo`, `date`, `memo`, `status`, `version`, `correctsJournalId`, `lines`）
- [ ] T065 [US2] `packages/domain/src/journal.ts` に `validateJournal(draft, ctx)` と `defaultTaxCategory(date, side, account, settings)` を実装する。T059, T060 が通ること
- [ ] T066 [US2] `packages/domain/src/usecases/create-journal.ts` を実装する: 検証 → `transaction` 内で `nextJournalNo` → `insertJournal` → `appendAudit(create)`。重複の警告を返す。T061 が通ること
- [ ] T067 [US2] `packages/db/src/ledger-repository.ts` に `transaction`, `nextJournalNo`（`max(journal_no) + 1`）, `insertJournal`, `getJournal`, `lastJournal`, `appendAudit` を実装する。T062 が通ること
- [ ] T068 [US2] `apps/server/src/routes/journals.ts` に `POST /journals` と `GET /journals/:journalId` を実装する。`OUT_OF_PERIOD` で日付が最後の会計期間より後のときは `details.suggest = "create_fiscal_period"` を付ける。T063 が通ること
- [ ] T069 [US2] `apps/web/src/features/journals/JournalForm.tsx` を実装する: `useFieldArray` で行を追加・削除、行ごとに借方/貸方・科目（使用停止の科目は選べない）・補助科目・金額・税区分（日付と科目から既定値を入れる）・取引先・摘要・タグ。借方合計・貸方合計・差額を常に表示する。API のエラーを該当の行・項目に表示し、`POSSIBLE_DUPLICATE` は登録後に通知する。`create_fiscal_period` の提案には会計期間の作成へのリンクを出す
- [ ] T070 [US2] `apps/web/src/routes/e/$entityId/journals/new.tsx`（入力画面）と `apps/web/src/routes/e/$entityId/journals/index.tsx`（仕訳の一覧。新しい順）を実装する。登録後に仕訳と帳票のクエリを無効化する

**Checkpoint**: US1 と US2 で記帳を始められる

---

## Phase 5: User Story 3 - 仕訳を訂正・取り消し、履歴と検索で確認する (Priority: P1)

**Goal**: 理由つきの訂正・取消、変更履歴の参照、締め済み年度への訂正仕訳、組み合わせ検索

**Independent Test**: 仕訳を訂正・取消すると履歴に変更前の内容と理由が残り、検索で条件どおりの仕訳だけが見つかる

### Tests for User Story 3 ⚠️

- [ ] T071 [P] [US3] `packages/domain/test/correct-journal.test.ts` を書く（フェイクのリポジトリ）: 理由が空・空白のみなら `REASON_REQUIRED`、`version` の不一致は `VERSION_CONFLICT`、締め済みの期間の仕訳は `PERIOD_CLOSED` で `details.suggest = "correcting_entry"`、新しい日付が締め済みの期間でも `PERIOD_CLOSED`、成功すると `version` が +1 され、audit_log の `before_json` に変更前の行・タグを含む全内容が入る（FR-020）。取消済みの仕訳は訂正できない
- [ ] T072 [P] [US3] `packages/domain/test/void-journal.test.ts` を書く: 理由が必須、取消後の `status` は `voided`、audit_log に `void` と変更前の内容が残る、締め済みの期間なら `PERIOD_CLOSED`
- [ ] T073 [P] [US3] `packages/domain/test/correcting-entry.test.ts` を書く（FR-019a）: `correctsJournalId` は締め済みの期間の仕訳だけを指せる（締めていない期間の仕訳を指すと `VALIDATION`）、訂正仕訳の日付は締めていない期間、元の仕訳から `correctingJournalsOf` で訂正仕訳をたどれる
- [ ] T074 [P] [US3] `packages/domain/test/history.property.test.ts` を書く（SC-005）: 任意の回数の訂正・取消の列を適用した後、`journalHistory` の各項目の `before_json` をたどると、すべての過去の版と理由を復元できる
- [ ] T075 [P] [US3] `packages/db/test/search.property.test.ts` を書く（FR-023, SC-006）: arbitraries で生成した仕訳群と、任意の `dateFrom`/`dateTo`/`amountMin`/`amountMax`/`partnerId`/`accountId`/`q`/`tagId`/`includeVoided` の組み合わせについて、`findJournals` の結果がメモリ上のオラクルのフィルターと一致する（漏れも余分もない）。金額の範囲は「いずれかの行の金額が範囲内」で一致。`cursor` で全ページをたどると重複も欠落もない
- [ ] T076 [P] [US3] `packages/db/test/ledger-repository.correct.test.ts` を書く: `replaceJournal` は行とタグを全件置き換え `version` を +1 する、`expectedVersion` の不一致で失敗する、`voidJournal` は行を残す、仕訳の更新と audit_log の追記が同じトランザクション（途中で例外なら両方とも残らない）
- [ ] T077 [P] [US3] `apps/server/test/journals.correct.api.test.ts` を書く: `PUT /journals/:id`（理由なし → 422 `REASON_REQUIRED`、古い version → 409 `VERSION_CONFLICT`）、`POST /journals/:id/void`、`GET /journals/:id/history`、`GET /journals?...` の検索、取消済みは既定で検索結果に出ない（`includeVoided=true` で出る）

### Implementation for User Story 3

- [ ] T078 [P] [US3] `packages/schema/src/journals.ts` に追加する: `JournalCorrection = JournalInput & { reason: z.string(), version: int }`、`VoidInput { reason: z.string(), version }`、`ReopenInput { reason: z.string() }`（`reason` の空欄・空白のみ・500文字超の判定は Zod ではなくドメインで行い、`REASON_REQUIRED` を返す。contracts/http-api.md）、`JournalQuery { dateFrom?, dateTo?, amountMin?, amountMax?, partnerId?, accountId?, q?, tagId?, includeVoided: boolean = false, cursor?, limit: int 1..200 = 50 }`、`HistoryEntry { occurredAt, action, reason, before, after }`
- [ ] T079 [US3] `packages/domain/src/usecases/correct-journal.ts` と `packages/domain/src/usecases/void-journal.ts` を実装し、`create-journal.ts` に訂正仕訳（`correctsJournalId`）の検証を追加する。T071〜T074 が通ること
- [ ] T080 [US3] `packages/db/src/ledger-repository.ts` に `replaceJournal`, `voidJournal`, `findJournals`（カーソルは `journal_no`）, `journalHistory`, `correctingJournalsOf` を実装する。T075, T076 が通ること
- [ ] T081 [US3] `apps/server/src/routes/journals.ts` に `PUT /journals/:id`, `POST /journals/:id/void`, `GET /journals/:id/history`, `GET /journals`（検索）を追加し、`GET /journals/:id` に訂正元と訂正仕訳の参照を含める。T077 が通ること
- [ ] T082 [US3] `apps/web/src/routes/e/$entityId/journals/$journalId.tsx` を実装する: 仕訳の詳細、訂正（JournalForm を再利用し、理由の入力ダイアログ）、取消（理由の入力）、変更履歴のタイムライン（変更前後の差分・日時・理由）、訂正元・訂正仕訳へのリンク、「取消済み」の表示。`PERIOD_CLOSED` のときは「当年度に訂正仕訳を起票」ボタンを出し、`correctsJournalId` を入れた入力画面を開く
- [ ] T083 [US3] `apps/web/src/routes/e/$entityId/journals/index.tsx` に検索フォームを追加する。検索条件は TanStack Router の `validateSearch`（`JournalQuery` の Zod スキーマ）で URL に持つ

**Checkpoint**: US1〜3（P1）が完成。日常の記帳と訂正ができる

---

## Phase 6: User Story 4 - 帳票を表示する (Priority: P2)

**Goal**: 仕訳帳・総勘定元帳・試算表・PL・BS を仕訳から導出して表示し、前年と比較し、CSV で出力する

**Independent Test**: 既知のフィクスチャで各帳票の値が手計算と一致し、試算表と BS の貸借が常に一致する

### Tests for User Story 4 ⚠️

- [ ] T084 [P] [US4] `packages/domain/test/fixtures/sample-year.ts` を作成する: 合成した1年分の期首残高と約30件の仕訳（売上・入金・振込手数料・家賃・消耗品・取消済みの仕訳1件を含む）と、手計算した試算表・PL・BS・普通預金の元帳の期待値
- [ ] T085 [P] [US4] `packages/domain/test/reports/trial-balance.property.test.ts` を書く: INV-4（任意の期首残高と仕訳で借方合計 = 貸方合計。**1万件の仕訳**で1回以上実行する, SC-003）、INV-6（取消済みの仕訳を加えても結果が変わらない）、フィクスチャの期待値と一致
- [ ] T086 [P] [US4] `packages/domain/test/reports/balance-sheet.property.test.ts` を書く: INV-5（任意の入力で資産 = 負債 + 純資産 + 当期利益。1万件の仕訳でも成立）、当期利益 = PL の差引金額、フィクスチャと一致
- [ ] T087 [P] [US4] `packages/domain/test/reports/general-ledger.test.ts` を書く: 前期繰越 = 期首残高 ＋ 会計期間の開始日から期間の開始日の前日までの累計、残高の推移が日付・仕訳番号順、相手科目（複合仕訳は「諸口」）、補助科目別の絞り込み、収益・費用の科目は会計期間ごとに 0 から始まる
- [ ] T088 [P] [US4] `packages/domain/test/reports/profit-and-loss.test.ts` を書く: 決算書の科目順、売上・経費の合計・差引、前年比較で `増減 = 当年 − 前年`、前年のデータがない科目は 0
- [ ] T089 [P] [US4] `packages/domain/test/reports/warnings.test.ts` を書く（FR-033, Edge Cases）: 資産の科目の残高がマイナス（例: 売掛金 ▲15,000）、負債の科目の残高が借方なら `NEGATIVE_BALANCE`（科目と金額）、期首残高が未登録なら `OPENING_BALANCE_MISSING`
- [ ] T090 [P] [US4] `packages/domain/test/reports/csv.test.ts` を書く（FR-032）: UTF-8 の BOM 付き、改行は CRLF、カンマ・引用符・改行を含む値のエスケープ、CSV の数値が帳票オブジェクトの数値と一致する（プロパティテスト）
- [ ] T091 [P] [US4] `apps/server/test/reports.api.test.ts` を書く: 5つの帳票の JSON、`format=csv` で `text/csv; charset=utf-8`、`compare=previous-year`、取消済みの仕訳が集計に含まれない（US4-5）、`warnings` が含まれる

### Implementation for User Story 4

- [ ] T092 [P] [US4] `packages/schema/src/reports.ts` を作成する: 各帳票のクエリ（`from`, `to`, `asOf`, `accountId`, `subAccountId?`, `compare?: "previous-year"`, `format?: "json" | "csv"`）とレスポンスの型（各帳票 ＋ `warnings`）
- [ ] T093 [US4] `packages/domain/src/reports/balances.ts` に共通の集計（科目・補助科目別の期首・借方・貸方・期末。取消済みを除外）を実装する
- [ ] T094 [US4] `packages/domain/src/reports/trial-balance.ts`（`buildTrialBalance`）と `packages/domain/src/reports/journal-book.ts` を実装する。T085 が通ること
- [ ] T095 [US4] `packages/domain/src/reports/general-ledger.ts`（`buildGeneralLedger`）を実装する。T087 が通ること
- [ ] T096 [US4] `packages/domain/src/reports/profit-and-loss.ts`（`buildProfitAndLoss`）と `packages/domain/src/reports/balance-sheet.ts`（`buildBalanceSheet`、当期利益を純資産に含める）を実装する。前年比較は同じ関数を前年の期間で呼んで差分を取る。T086, T088 が通ること
- [ ] T097 [P] [US4] `packages/domain/src/reports/warnings.ts`（`detectWarnings`）を実装する。T089 が通ること
- [ ] T098 [P] [US4] `packages/domain/src/reports/csv.ts`（`toCsv`）を実装する。T090 が通ること
- [ ] T099 [US4] `packages/db/src/ledger-repository.ts` の `linesInRange(from, to)`（有効な仕訳の行を科目・補助科目・取引先と結合して1クエリで取得, R12）と `openingBalances(fiscalYear)` を実装する
- [ ] T100 [US4] `packages/domain/src/usecases/reports.ts` を実装する（期間 → 会計期間の解決、リポジトリからの取得、純関数の呼び出し、警告の付与）
- [ ] T101 [US4] `apps/server/src/routes/reports.ts` に5つの帳票のエンドポイントを実装する（contracts/http-api.md）。`format=csv` のときは `toCsv` の結果を返す。T091 が通ること
- [ ] T102 [US4] `apps/web/src/features/reports/` に共通の部品（期間の選択、比較の切替、警告のバナー、CSV のダウンロード、TanStack Table の金額列（3桁区切り、マイナスは ▲））を作成する
- [ ] T103 [US4] `apps/web/src/routes/e/$entityId/reports/` に `journal-book.tsx`, `general-ledger.tsx`, `trial-balance.tsx`, `profit-and-loss.tsx`, `balance-sheet.tsx` を実装する。期間などの条件は URL の検索パラメータに持つ。元帳の行から仕訳の詳細に移動できる

**Checkpoint**: 記帳の結果を帳票で確認できる

---

## Phase 7: User Story 5 - 年度を締める (Priority: P2)

**Goal**: 年度を締めて変更を防ぎ、理由つきで解除できる

**Independent Test**: 締めた年度の日付で仕訳の登録・訂正・取消ができず、解除すると再びできる

### Tests for User Story 5 ⚠️

- [ ] T104 [P] [US5] `packages/domain/test/close-period.test.ts` を書く: `closePeriod` で `status = closed`・`closed_at` が入り audit_log に `close`、`reopenPeriod` は理由が必須（`REASON_REQUIRED`）で audit_log に `reopen` と理由、締め済みの期間に対する登録・訂正・取消・期首残高の置換がすべて `PERIOD_CLOSED`（INV-7）、締め済みの期間を再度締めても状態は変わらない
- [ ] T105 [P] [US5] `packages/domain/test/ledger-ops.property.test.ts` を書く（INV-7, INV-8 のプロパティテスト, Constitution I・V）: フェイクのリポジトリに対して、登録・訂正・取消・締め・解除・訂正仕訳の起票をランダムな順に並べた操作列（fast-check の `fc.commands` または操作の配列）を実行する。各ステップの後で、(1) 締め済みの期間に属する仕訳の内容・状態・version が、締めた時点のスナップショットと一致する（INV-7）、(2) 仕訳番号が 1 から抜けなく増え、重複しない（INV-8）、(3) 有効な仕訳がすべて貸借一致している（INV-1）ことを検証する
- [ ] T106 [P] [US5] `apps/server/test/periods.close.api.test.ts` を書く: `POST /fiscal-periods/2026/close` → 以降の 2026 年の日付の `POST /journals` は 409 `PERIOD_CLOSED`、`POST /reopen` で理由なし → 422、理由ありで再び登録できる

### Implementation for User Story 5

- [ ] T107 [US5] `packages/domain/src/usecases/close-period.ts` に `closePeriod` と `reopenPeriod` を実装する（audit_log の `target_type = fiscal_period`）。T104 と T105 が通ること
- [ ] T108 [US5] `packages/db/src/master-repository.ts` に会計期間の状態の更新を追加し、`apps/server/src/routes/periods.ts` に `POST /fiscal-periods/:year/close` と `POST /fiscal-periods/:year/reopen` を追加する。T106 が通ること
- [ ] T109 [US5] `apps/web/src/routes/e/$entityId/periods/index.tsx` に締め・解除のボタン（確認ダイアログ、解除は理由の入力）と、締めと解除の履歴を追加する

**Checkpoint**: 申告後の帳簿を保護できる

---

## Phase 8: User Story 6 - 2つ目の事業体に切り替える (Priority: P3)

**Goal**: 複数の事業体を作り、画面で切り替える。データは互いに見えない

**Independent Test**: 2つの事業体に仕訳を登録し、一方の帳票・検索・CSV にもう一方の仕訳が現れない

### Tests for User Story 6 ⚠️

- [ ] T110 [P] [US6] `packages/db/test/isolation.property.test.ts` を書く（FR-002, SC-007）: 2つのテナントに arbitraries の仕訳を登録し、それぞれの `findJournals`・`linesInRange`・`openingBalances` の結果が自分のテナントの ID だけを含む。DB ファイルが2つ別に存在する
- [ ] T111 [P] [US6] `apps/server/test/isolation.api.test.ts` を書く: 事業体 A の仕訳の ID・摘要が、事業体 B の検索・5つの帳票の JSON と CSV・`GET /journals/:id`（A の ID を B のパスで指定 → 404）に一切現れない。`kind: "corporation"` の事業体を作成できる（US6-2）

### Implementation for User Story 6

- [ ] T112 [US6] テストで漏れが見つかった箇所を修正する（想定では T027・T031 の構造で満たされる。修正がなければ、その旨をこのタスクに記録して完了とする）
- [ ] T113 [US6] `apps/web/src/features/entities/EntitySwitcher.tsx` を実装して `__root.tsx` のヘッダーに置く: 事業体の一覧から選んで `/e/$entityId` に移動する、最後に選んだ事業体を `localStorage` に保存してトップ画面で復元する、切り替え時に TanStack Query のキャッシュを破棄する（別の事業体のデータが一瞬表示されるのを防ぐ）

**Checkpoint**: すべてのユーザーストーリーが独立して動く

---

## Phase 9: Polish & Cross-Cutting Concerns

- [ ] T114 [P] `apps/web/e2e/ledger-flow.spec.ts` に Playwright の E2E を書く: 事業体の作成 → 期首残高 → 仕訳2件（単一・複合）→ 貸借不一致の拒否 → 試算表の合計の一致。`TREBUCHET_DATA_DIR` は `.tmp/e2e-<uuid>`。`pnpm --filter @trebuchet/web e2e` で実行する
- [ ] T115 [P] `scripts/bench-reports.ts` と ルートの `bench:reports` を作成する（SC-004）: `.tmp/` のテナントに 2,000 件 × 平均3行の仕訳を登録し、5つの帳票の API の応答時間を測って、いずれかが 1 秒を超えたら非ゼロで終了する
- [ ] T116 [P] `AGENTS.md` を作成する: 構成と依存の向き、コマンド（`pnpm dev`/`test`/`typecheck`/`lint`/`bench:reports`）、テストファーストと不変条件、テストの一時ファイルは `.tmp/`、実データ（`work/`, `data/`）を読まない・コミットしない、Spec Kit の成果物の場所
- [ ] T117 [P] `README.md` を作成する（概要、前提、セットアップ、`pnpm dev`、データの保存先と `TREBUCHET_DATA_DIR`）
- [ ] T118 [P] 設計判断を ADR として記録する（Constitution の Development Workflow）: `docs/adr/0002-tenant-per-db-file.md`（事業体ごとの DB ファイル分離と `entity_id` 列を持たない理由、research.md R9・data-model §0）、`docs/adr/0003-correction-policy.md`（訂正方式 C 案、research.md R11、spec の Assumptions）。形式は「状況・決定・理由・検討した代替案・影響」。0001 は T001 で作成済みであることを確認する
- [ ] T119 `pnpm typecheck && pnpm lint && pnpm test` を実行し、Biome の `noRestrictedImports` で `packages/domain` の境界違反がないことを確認する
- [ ] T120 `specs/001-ledger-core/quickstart.md` の手順（自動テスト・手動確認の1〜9）を実施し、SC-001（10分以内）と SC-002（30秒・1分以内）を含めて結果を確認する。手順と実装に食い違いがあれば quickstart.md を更新する

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: 依存なし。**T001（PoC）が最初のゲート**で、結果によって T008 以降のドライバーが決まる
- **Foundational (Phase 2)**: Setup の完了後。すべてのユーザーストーリーをブロックする
- **US1 (Phase 3)**: Foundational の完了後
- **US2 (Phase 4)**: US1 の完了後（事業体・科目・会計期間・消費税の設定が必要）
- **US3 (Phase 5)**: US2 の完了後（登録済みの仕訳が必要）
- **US4 (Phase 6)**: US2 の完了後。US3 とは並行できる（取消の除外のテストは、リポジトリに直接 `voided` の仕訳を作って行う）
- **US5 (Phase 7)**: US2 の完了後。US3 の訂正・取消を締めで拒否するテスト（T104 の一部）は US3 の完了後
- **US6 (Phase 8)**: US4 の完了後（帳票・CSV での分離を検証するため）
- **Polish (Phase 9)**: すべてのストーリーの完了後

### User Story Dependencies

```text
Setup → Foundational → US1 → US2 ─┬→ US3 ─┐
                                  ├→ US4 ─┼→ US6 → Polish
                                  └→ US5 ─┘
```

### Within Each User Story

- テストを書き、**失敗することを確認**してから実装する
- 順序: schema → domain（純関数）→ usecase → db リポジトリ → server ルート → web 画面
- 各ストーリーの完了時にコミットする

### Parallel Opportunities

- Setup: T003〜T012 は並列
- Foundational: T014・T015・T016・T018・T020・T023 は並列。T021 → T022 → T024 → T025 は順番に
- 各ストーリーのテスト（[P]）はすべて並列に書ける
- US1 の T043〜T047、T054〜T058 は並列
- US2 の完了後、US3・US4・US5 は並行できる

---

## Parallel Example: User Story 1

```bash
# テストをまとめて書く
Task: "T036 seed-accounts.test.ts"
Task: "T037 tax-settings.property.test.ts"
Task: "T038 opening.property.test.ts"
Task: "T039 create-entity.test.ts"
Task: "T040 masters.test.ts"

# 純関数とスキーマをまとめて実装する
Task: "T043 accounts.individual.ts"
Task: "T045 tax-settings.ts"
Task: "T046 opening.ts"
Task: "T047 schema/entities.ts, masters.ts"
```

## Parallel Example: User Story 4

```bash
Task: "T085 trial-balance.property.test.ts"
Task: "T086 balance-sheet.property.test.ts"
Task: "T087 general-ledger.test.ts"
Task: "T089 warnings.test.ts"
Task: "T090 csv.test.ts"
```

---

## Implementation Strategy

### MVP First

1. Phase 1（PoC を含む）→ Phase 2
2. Phase 3（US1）→ **確認**: 事業体の作成と期首残高
3. Phase 4（US2）→ **確認**: 仕訳の登録と拒否。ここで記帳を始められる最小の状態
4. Phase 5（US3）→ P1 がそろう。電子帳簿保存法の訂正削除履歴と検索を満たす

### Incremental Delivery

1. US1 ＋ US2 ＋ US3（P1）→ 日常の記帳
2. ＋ US4 → 帳票で確認できる。ここで 002（freee 取込）に進める状態になる
3. ＋ US5 → 申告後の保護
4. ＋ US6 → 法人の準備

### 学習のための進め方

- 1つのタスクを「テストを書く → 失敗を確認 → 実装 → 通る → コミット」の小さな単位で回す
- プロパティテストが失敗したら、fast-check が縮小した最小の反例をテストケースとして残す

---

## Notes

- [P] = 別ファイルで、依存がない
- [Story] = spec.md のユーザーストーリーとの対応
- 帳票の集計値を保存するテーブルを作らない（FR-031）
- 仕訳の削除 API を作らない（FR-022）
- 認証・バックアップ（003）、freee の取込と SC-008 の実データ照合（002）は本機能の範囲外
