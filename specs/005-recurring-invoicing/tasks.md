---

description: "Task list for 005-recurring-invoicing"
---

# Tasks: 定期仕訳と工数・請求（日常業務）

**Input**: Design documents from `specs/005-recurring-invoicing/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/http-api.md](./contracts/http-api.md), [quickstart.md](./quickstart.md)

**Tests**: 必須。Constitution V（テストファースト）により、各ユーザーストーリーでテストを先に書き、**失敗することを確認してから**実装する。不変条件 INV-30〜39（data-model §4）は fast-check のプロパティテストで検証する（`fc.assert(fc.property(...))` を直接呼ぶ。`@fast-check/vitest` は使わない）。

**Organization**: ユーザーストーリーごとにまとめる。US4（設定）は US1（請求）の前提なので先に置く。「テスト → 実装」の対は同じタスクの中に置き、1体の部下にまとめて渡す。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 並列にしてよい（別ファイルで、未完了のタスクに依存しない）。並列に実行する指示ではない（部下は1体ずつ順番に動かす）
- **[Story]**: 対応するユーザーストーリー（US1〜US4）
- 参照: `R` は research.md、`INV` と `§` は data-model.md、`H:§` は contracts/http-api.md の節、`FR`・`SC` は spec.md

## 全タスク共通のルール

- 004 の tasks.md の「全タスク共通のルール」を引き継ぐ（依存の向き、整数の金額、`IdGenerator`・`Clock`、テストの一時ファイルは `.tmp/` と `useTempDataDir`、相対 import に `.ts`、enum・parameter properties・namespace を使わない、型だけの import は `import type`、実データ `work/`・`data/` を読まない・書かない、部下は担当のプロジェクトのテストだけを実行し整形は触ったファイルだけ、ファイルの変更は Edit / Write、Conventional Commits）
- 開発中は利用者がいないため、既存データの移行・旧版との互換は考慮しない。帳簿の不変条件（Constitution I）は守る
- **金額・工数は整数**。工数は半時間の整数（`half_hours`）、明細の数量は `quantity_halves`。明細の金額 = `Math.floor(quantityHalves * unitPrice / 2)`。別記の税額は 001 の `computeInclusiveTax`（INV-10 の式）を税率ごとに1回（R7）。浮動小数で金額を計算しない
- **書く順序（R9）**: drizzle のトランザクションは `err` を返しても確定する。ユースケースは (1) 読み取りと検査をすべて先に行い違反は `err`、(2) 最初の書き込みを 001 の `createJournal` / `voidJournal` にし、その `err` はそのまま返す、(3) 以降の書き込みの失敗・ドメインの判断での中止は `RollbackError`（`DomainError` を持つ例外）を投げて全体を巻き戻し、ユースケースの外側で `err` に直す
- **「今日」はドメインに `today: string`（`YYYY-MM-DD`）で渡す**。server は `todayOf(clock)`（R22）で作る。`Date.now()`・`new Date()` を domain・ルートで直接呼ばない
- **エラーコード・共有の型（`JournalSource`、schema の型）・`createJournal` の引数を変えるタスクでは、同じ値を参照するテストと実装を `grep -rn <値> packages apps scripts` で探し、担当外のプロジェクトも含めて直す**
- server のテストは `apps/server/test/helpers.ts` の `createTestSession`・`testHeaders`（と `createTestEntity`）を使う（全ルートが要サインイン。004 の INV-29 の `auth-coverage.test.ts` が新しいルートも自動で検査する）。日付に依存するテストは偽の時計を `createApp({ clock })` で渡し、時刻を日付の境目（UTC と JST の 0 時）から離す
- web のテストは Testing Library ＋ jsdom（`apps/web/test/render-route.tsx`、`apps/web/test/mock-api.ts`、置き場所は `apps/web/test/routes/`）。**新しい API を呼ぶ画面を足したら `mock-api.ts` に既定の応答を足し、既存の web のテストが落ちないことを確かめる**。ルートを足したら `pnpm --filter @trebuchet/web build` で `routeTree.gen.ts` を再生成してから typecheck する
- マイグレーションは `pnpm --filter @trebuchet/db exec drizzle-kit generate --name invoicing --config drizzle.tenant.config.ts` の後に、新しい表の `);` を `) STRICT;` に置き換える。トリガーは `--custom --name invoicing_integrity`（AGENTS.md）
- サンドボックスではローカルのポートを開けない。部下は `app.request()` とメモリ上のテストだけで確かめ、server を起動しない

---

## Phase 1: Setup

依存の追加・ゲートはない（plan の Technical Context）。Phase 2 から始める。

---

## Phase 2: Foundational（全ストーリーの前提）

**Purpose**: スキーマとエラーコード、tenant の10表とトリガー、001 の仕訳の関数の変更、ポートと UnitOfWork、今日の日付と時計の配線

- [X] T001 [P] `packages/schema/src/invoicing.ts` と `recurring.ts` を作って `packages/schema/src/index.ts` から export し、`packages/schema/src/errors.ts` の `ErrorCode` に H:§1 の**14種**を足す: `INVOICE_NOT_FOUND`、`PAYMENT_NOT_FOUND`、`RECURRING_NOT_FOUND`、`BILLING_TERMS_MISSING`、`INVOICE_ISSUER_INCOMPLETE`、`PARTNER_INACTIVE`、`INVOICE_DUPLICATE_MONTH`、`INVOICE_VOIDED`、`INVOICE_HAS_PAYMENTS`、`PAYMENT_EXCEEDS_BALANCE`、`PAYMENT_VOIDED`、`INVOICE_SEQ_TOO_LOW`、`JOURNAL_LINKED`、`RECURRING_CONFIRM_REQUIRED`（警告のコードに `INVOICE_DUPLICATE_MONTH` も足す）。`apps/server/src/errors.ts` の `ERROR_STATUS` に H:§1 の HTTP ステータス（404: `INVOICE_NOT_FOUND`・`PAYMENT_NOT_FOUND`・`RECURRING_NOT_FOUND`、422: `BILLING_TERMS_MISSING`・`INVOICE_ISSUER_INCOMPLETE`・`PARTNER_INACTIVE`・`PAYMENT_EXCEEDS_BALANCE`・`INVOICE_SEQ_TOO_LOW`、409: `INVOICE_DUPLICATE_MONTH`・`INVOICE_VOIDED`・`INVOICE_HAS_PAYMENTS`・`PAYMENT_VOIDED`・`JOURNAL_LINKED`・`RECURRING_CONFIRM_REQUIRED`）。スキーマは H:§2〜§6 の入出力（`InvoiceSettingsInput`、`BillingTermsInput`、`WorkHoursInput`、`InvoiceDraftRequest`、`InvoiceInput`、`PaymentInput`、`InvoicingVoidInput`〔`{ reason }` だけ。001 の `VoidInput` は `version` が必須なので使わない。H:§1 の末尾〕、`RecurringInput`、`RecurringUpdate`、`ResumeInput`、`AcknowledgeInput` と応答の型）。検査: `hours` は 0 以上かつ `Number.isInteger(hours * 2)`（`1.25` は拒否）、明細は 1〜5 行で `name` は空でない・`amount` は正の整数・`quantity` は 0.5 の倍数で正、`billingType: "hourly"` は `unitPrice` が正の整数で `monthlyAmount` なし・`"monthly"` はその逆、`dueMonthsAfter` 0〜12、`dueDay`・`dayOfMonth` は 1〜28 または 31（末日。29・30 は拒否。R8）、`registrationNumber` は `T` ＋ 13 桁、月は `YYYY-MM`、`taxDisplay` は `separate`・`inclusive_only`。テスト `packages/schema/test/invoicing.test.ts`・`recurring.test.ts`（各境界値、`dueDay`・`dayOfMonth` の 28・29・30・31、`InvoicingVoidInput` が `version` なしで通り `reason` なしで落ちる、`ErrorCode` に14種が入る）。`grep -rn "ErrorCode" apps packages` で、全コードを網羅する表（`ERROR_STATUS`、web の文言表）の型エラーを担当外も含めて直す
- [X] T002 [P] tenant の10表とトリガーを足す（data-model §1・§2、R15）。`packages/db/src/schema/tenant.ts` に次を足し、`0005_invoicing.sql` を生成して STRICT にし、`0006_invoicing_integrity.sql`（`--custom`）にトリガーを書く。列の制約（data-model の原文）:
  - `invoice_settings`: `id` integer PK `CHECK (id = 1)`、`issuer_name` text NOT NULL、`trade_name` NULL 可、`address`・`contact`・`bank_account` NOT NULL、`registration_number` NULL 可 `CHECK (registration_number GLOB 'T[0-9]*' AND length = 14)`、`tax_display` 「`separate`（別記）/ `inclusive_only`（税込のみ）。CHECK。既定 `inclusive_only`」、`next_seq` 「`>= 1`。既定 1」、`updated_at`
  - `partner_billing_terms`: `partner_id` PK・FK → `partners.id`、`billing_type` 「`hourly` / `monthly`（CHECK）」、`unit_price` 「`hourly` なら NOT NULL かつ `> 0`、`monthly` なら NULL（CHECK）」、`monthly_amount` 「`monthly` なら NOT NULL かつ `> 0`、`hourly` なら NULL（CHECK）」、`due_months_after` 「`BETWEEN 0 AND 12`。既定 1」、`due_day` 「`BETWEEN 1 AND 28 OR due_day = 31`（31 = 末日。29・30 は不可）。既定 31」、`default_item_name` 「`length > 0`」、`billing_name` NULL 可、`updated_at`
  - `work_hours`: PK（`partner_id`, `target_month`）、`target_month` 「`YYYY-MM`（`GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'`）」、`half_hours` 「`>= 0`」
  - `invoices`: `invoice_no` NOT NULL UNIQUE、`seq` 「NOT NULL UNIQUE、`>= 1`」、`partner_id` FK、`target_month`、`issue_date`・`sales_date`・`due_date` NOT NULL、`recipient_name` 「`length > 0`」、`recipient_honorific` 「`様` / `御中`」、`issuer_json` NOT NULL、`tax_display` 「`separate` / `inclusive_only`」、`total` 「`> 0 AND < 10^12`」、`journal_id` 「NOT NULL UNIQUE、FK → `journals.id`」、`created_at`、`voided_at` / `void_reason` 「NULL 可。CHECK: 両方 NULL か両方 NOT NULL」、`void_journal_id` NULL 可・FK。索引 `(partner_id, target_month)`、`(due_date)`
  - `invoice_items`: `line_no` 「`BETWEEN 1 AND 5`。UNIQUE（`invoice_id`, `line_no`）」、`name` 「`length > 0`」、`quantity_halves` 「NULL 可、`> 0`」、`unit` NULL 可、`unit_price` 「NULL 可、`> 0`」、`amount` 「`> 0 AND < 10^12`。数量と単価がともにあれば `amount = (quantity_halves * unit_price) / 2`（CHECK）」、`tax_category` FK → `tax_categories.code`、`tax_rate` NULL 可
  - `invoice_payments`: `received_on` NOT NULL、`amount` 「`> 0`」、`fee_amount` 「`>= 0`」、`deposit_account_id` FK、`deposit_sub_account_id` NULL 可・FK、`journal_id` NOT NULL UNIQUE・FK、`created_at`、`voided_at`・`void_reason`・`void_journal_id` は `invoices` と同じ。索引 `(invoice_id)`
  - `recurring_journals`: `name` 「`length > 0`」、`memo` NULL 可、`day_of_month` 「`BETWEEN 1 AND 28 OR day_of_month = 31`（29・30 は不可）」、`start_month` `YYYY-MM`、`end_month` 「NULL 可、`>= start_month`」、`status` 「`active` / `paused`（CHECK）」、`version` 「`>= 1`」、`created_at`・`updated_at`
  - `recurring_journal_lines`: `line_no` 「UNIQUE（`recurring_id`, `line_no`）」、`side` 「`debit` / `credit`」、`account_id`・`sub_account_id`（補助は NULL 可）、`amount` 「`> 0 AND < 10^12`」、`tax_category` NULL 可、`partner_id` NULL 可、`description` NULL 可
  - `recurring_runs`: 「**UNIQUE（`recurring_id`, `target_month`）**」、`status` 「`posted` / `skipped`（CHECK）」、`journal_id` 「`posted` なら NOT NULL、`skipped` なら NULL（CHECK）。UNIQUE、FK」、`skip_reason` 「`skipped` なら NOT NULL」、`created_at`、`acknowledged_at` NULL 可
  - `invoicing_audit_log`: 003 の `closing_audit_log` と同じ列。`target_type` 「`invoice_settings` / `billing_terms` / `work_hours` / `invoice` / `payment` / `recurring_journal` / `recurring_run`」、`action` 「`create` / `update` / `void` / `pause` / `resume` / `skip` / `acknowledge`（CHECK）」
  - トリガー（data-model §2 の表の全行）: `journals_source_insert` / `journals_source_update`（「`source NOT IN ('manual','import_freee','invoice','payment','recurring')` なら ABORT」）、`invoices_no_delete`・`invoice_items_no_delete`・`invoice_payments_no_delete`・`recurring_runs_no_delete`、`invoices_void_only`・`invoice_payments_void_only`（取消の列以外の更新、取消済みの行の更新を ABORT）、`invoice_items_no_update`、`recurring_runs_ack_only`（`acknowledged_at` を NULL から付ける以外の更新を ABORT）、`invoice_settings_seq_floor`（「`NEW.next_seq <= (SELECT max(seq) FROM invoices)` なら ABORT」）、`invoicing_audit_log_no_update` / `_no_delete`
  - `journals.source` の enum（`tenant.ts`）と domain の `JournalSource`（`packages/domain/src/types.ts`）に `invoice`・`payment`・`recurring` を足す（R15。schema に `source` の定義はない）。**`grep -rn "import_freee\|JournalSource" packages apps` で同じ値を参照するテスト・実装を、担当外のプロジェクトも含めて直す**。004 のバックアップのアプリの版（tenant のマイグレーションの適用数）を数えるテストがあれば直す
  - **DB のトリガー・CHECK・UNIQUE の検査のテストはここに一本化する**。ほかのタスク（T007・T012・T017・T021）は振る舞いのテストだけを書き、トリガー・UNIQUE の個別のテストを書かない
  - テスト `packages/db/test/invoicing-schema.test.ts`（`useTempDataDir`）: 10表すべて STRICT、上の各 CHECK の違反が失敗（`due_day`・`day_of_month` の 29・30 を含む）、各トリガー（削除・請求書と消し込みの写しの更新・取消済みの行の更新・明細の更新・`acknowledged_at` 以外の更新・`next_seq` の下限・`source` の列挙外）が失敗し許す更新は通る、`recurring_runs` の（定期仕訳, 月）の重複と `invoices.seq` の重複が失敗
- [X] T003 001 の仕訳の関数を最小に変える（R9・R13、INV-39、H:§6 の末尾）。(1) `packages/domain/src/usecases/create-journal.ts`: `createJournal(deps, draft, options?: { source?: JournalSource })`（省略時 `manual`。`insertJournal` に渡す）。`checkCorrectsTarget` に「訂正元の `source` が `invoice`・`payment` なら、起票する仕訳の `source` が同じときだけ許す。違えば 409 `JOURNAL_LINKED`（domain は `details.journalId` だけを返す）」を足す。(2) `void-journal.ts`・`correct-journal.ts`・`journal-edit.ts`: `options?: { linked?: boolean }` を足し、`linked` でないのに `source` が `invoice`・`payment` なら `JOURNAL_LINKED`。`source = recurring` は通常どおり訂正・取消できる。(3) `packages/domain/src/invoicing/rollback.ts` に `RollbackError`（`DomainError` を持つ）と、`uow.transaction` を包んで `RollbackError` を `err` に直す `runInTransaction` を置く。`apps/server/src/routes/journals.ts` は `JOURNAL_LINKED` を `fail` で返す（`ERROR_STATUS` は T001）。`details` の `invoiceId`・`paymentId` を `originOfJournal`（T004）で補う処理はルート層の仕事で、`invoicingDeps`（T005）が揃ってから T005 で足す（契約 H:§1、R13）。**`createJournal(` の呼び出しを `grep -rn "createJournal(" packages apps scripts` で洗い、型エラーがないことを確かめる**。テスト `packages/domain/test/journal-linked.property.test.ts`（INV-39: 任意の `source` と操作〔訂正・取消・訂正元にした起票〕で、`invoice`・`payment` の仕訳は `linked` なしなら必ず `JOURNAL_LINKED`、`linked` ありなら通る、`manual`・`recurring`・`import_freee` は従来どおり）、`create-journal.test.ts` に `source` の保存を足す、`apps/server/test/journals.correct.api.test.ts` に `JOURNAL_LINKED` の 409（この段階は `details.journalId`）を足す
- [X] T004 ポートと UnitOfWork を足す（R9、data-model §5）。`packages/domain/src/ports.ts` に `InvoicingStore`・`InvoicingUnitOfWork`（`transaction(fn: (tx: { ledger: LedgerRepository; masters: MasterRepository; invoicing: InvoicingStore }) => T): T`）・`RecurringStore`・`RecurringUnitOfWork`（`{ ledger, masters, recurring }`）を、**中身のメソッドは `InvoicingStore` の `appendInvoicingAudit`・`originOfJournal(journalId)` と、`RecurringStore` の `appendRecurringAudit`（どちらも `invoicing_audit_log` に追記する。R23）だけ**で定義する（ほかのメソッドは各ストーリーの db のタスクで、ポートと実装を同時に足す）。`packages/db/src/invoicing-repository.ts`・`recurring-repository.ts` に `DrizzleInvoicingStore`・`DrizzleInvoicingUnitOfWork`・`DrizzleRecurringStore`・`DrizzleRecurringUnitOfWork`（003 の `DrizzleClosingUnitOfWork` と同じ形。同じ接続で `DrizzleLedgerRepository`・`DrizzleMasterRepository` を作る）、`packages/domain/test/fakes.ts` に `FakeInvoicingUnitOfWork`・`FakeRecurringUnitOfWork`（**例外で巻き戻し、`err` を返すと確定する**ことを drizzle と同じに再現する。003 の `fake-closing-unit-of-work.test.ts` の形）。`originOfJournal` は `invoices.journal_id`・`void_journal_id`、`invoice_payments.journal_id`・`void_journal_id`、`recurring_runs.journal_id` から H:§6.1 の形を返す。テスト `packages/db/test/invoicing-uow.test.ts`（`DrizzleInvoicingUnitOfWork`・`DrizzleRecurringUnitOfWork` の中で仕訳を作った後に例外を投げると仕訳も残らない、`originOfJournal` の往復、`appendInvoicingAudit`・`appendRecurringAudit` の追記）、`packages/domain/test/fake-invoicing-unit-of-work.test.ts`
- [X] T005 今日の日付と時計の配線（R22、R18 の土台）。`apps/server/src/lib/today.ts` の `todayOf(clock, timeZone?): string`（`clock.now()` を暦日 `YYYY-MM-DD` にする。`Intl.DateTimeFormat` の `timeZone`、省略時は実行環境の既定 = Mac のローカル）。`apps/server/src/app.ts` で `tenantRoutes` を `createApp` の中で組み立て、`invoicingRoutes({ clock })`（`routes/invoicing.ts`）と `recurringRoutes({ clock })`（`routes/recurring.ts`）を空の Hono で作って登録する（エンドポイントは各ストーリーで足す）。`apps/server/src/deps.ts` に `invoicingDeps(db)`・`recurringDeps(db)`（UnitOfWork、`ids`。`clock` はルートから渡す）。`apps/server/src/routes/journals.ts` の `JOURNAL_LINKED`（T003）に、`invoicingDeps` の `originOfJournal` で `invoiceId`・`paymentId` を補う（`details: { journalId, invoiceId, paymentId? }`。H:§1、R13）。`AppType` の型が変わらず web の `hc<AppType>` が型検査を通ることを確かめる。テスト `apps/server/test/journals.correct.api.test.ts` に、請求・入金の仕訳（`insertJournal` で `source` を直接指定して作り、`invoices` / `invoice_payments` の行を直接挿入する）の 409 が `invoiceId`・`paymentId` を含むことを足す、`apps/server/test/today.test.ts`（`timeZone: "Asia/Tokyo"` を渡し、UTC の `2026-10-25T15:30:00Z` が `2026-10-26`、`2026-10-25T14:59:00Z` が `2026-10-25`。CI の `TZ` に依存させない）

**Checkpoint**: `pnpm vitest run --project schema`、`--project domain`、`--project db`、`--project server` が通る

---

## Phase 3: User Story 4 - 請求の条件と発行者の情報を設定する (Priority: P1)

**Goal**: 発行者の設定、取引先の請求の条件、期限・番号・金額の純関数

**Independent Test**: 「翌月 10 日」の取引先の 12 月分の期限が翌年 1 月 10 日、次の通し番号 043 の設定と、発行済みの最大以下への変更の拒否

- [X] T006 [P] [US4] テスト先行で純関数を実装する（R6・R7・R8）: `packages/domain/src/invoicing/due-date.ts` の `clampDay(year, month, day)`・`dueDate(targetMonth, monthsAfter, day)`、`number.ts` の `formatInvoiceNo(issueDate, seq)`（`YYYYMMDD-` ＋ `String(seq).padStart(3, "0")`、1000 以上は桁が増える）、`amounts.ts` の `itemAmount(quantityHalves, unitPrice)`・`hoursToHalves(hours)`・`taxBreakdown(items)`（税率ごとに `{ rate, inclusive, tax, exclusive }`、`tax = computeInclusiveTax(inclusive, rate)`、税率なしは税額 0）。`packages/domain/src/index.ts` から export。テスト `packages/domain/test/invoicing/due-date.property.test.ts`（INV-36: `clampDay` は常に 1 日〜末日、`dueDate` は n か月後の月にあり `d >= 末日` なら末日、12 月分 + 1 = 翌年 1 月、うるう年の 2 月）、`amounts.property.test.ts`（INV-37: 明細の金額が `floor(halves × price / 2)`、税率ごとに `exclusive + tax = inclusive`、すべて整数）、`number.test.ts`（`20261101-043`、`20261101-1000`）、US1 Acceptance 1 の `120.5 時間 × 10,000 円 = 1,205,000 円`、Edge Case の `0.5 時間 × 10,001 円 = 5,000 円`
- [X] T007 [US4] テスト先行で設定と条件のユースケースと永続化を実装する（R4・R5・R6・R23、§1.1・§1.2、FR-001〜004）。`packages/domain/src/usecases/invoicing.ts` に `getInvoiceSettings`（`minimumNextSeq` = 発行済みの最大の `seq` + 1、なければ 1）、`saveInvoiceSettings`（`nextSeq < minimumNextSeq` は 422 `INVOICE_SEQ_TOO_LOW`、`details.minimum`）、`listBillingTerms`、`saveBillingTerms`（取引先がなければ `VALIDATION`、`details.field = "partnerId"`）、`deleteBillingTerms`、`isIssuerComplete(settings)`（`issuer_name`・`address`・`contact`・`bank_account` が空でない。欠けた項目を返す）。変更は `invoicing_audit_log` に `invoice_settings`・`billing_terms` の `create`・`update` を残す（同じトランザクション）。`InvoicingStore` に設定と条件の読み書きのメソッドを足し、`DrizzleInvoicingStore` と偽物に実装する。テスト `packages/domain/test/invoicing/settings.test.ts`（下限、監査の記録、条件の型ごとの保存）、`packages/db/test/invoicing-settings.test.ts`（設定・条件の保存と読み戻しの往復、条件の削除）。トリガーの検査は T002
- [X] T008 [US4] テスト先行で H:§2.1〜§2.5 のルートを `apps/server/src/routes/invoicing.ts` に足す（`createTestSession`・`testHeaders`・`createTestEntity` を使う）。テスト `apps/server/test/invoicing.settings.api.test.ts`: 往復、`INVOICE_SEQ_TOO_LOW` の 422、型に合わない金額の `VALIDATION`、条件の削除の 204、`GET /billing-terms` の `partnerName`・`honorific`・`partnerActive`
- [X] T009 [US4] テスト先行で web の設定の画面を作る（FR-001〜004）。`apps/web/src/features/invoicing/IssuerSettingsForm.tsx`・`BillingTermsForm.tsx`・`api.ts`、`apps/web/src/routes/e/$entityId/invoice-settings.tsx`（発行者・消費税の表示・次の通し番号〔`minimumNextSeq` の案内〕）、`apps/web/src/routes/e/$entityId/partners.tsx` に請求の条件の編集（型の切り替え、単価・月額、期限の「N か月後」「1〜28 日・末日」、既定の品名、宛名、敬称は 001 の `PATCH /partners/:id` の `honorific`）。ナビに「請求」。`mock-api.ts` に `GET /invoice-settings`（`settings: null`）・`GET /billing-terms`（空）の既定の応答を足す。テスト `apps/web/test/routes/invoice-settings.test.tsx`・`partners-billing.test.tsx`（保存、`INVOICE_SEQ_TOO_LOW` の文言、0 や小数の単価で保存できない）

**Checkpoint**: 設定と条件が server と web で保存でき、期限・番号・金額の純関数が INV-36・37 を満たす

---

## Phase 4: User Story 1 - 月末に工数を入れて請求書を出す (Priority: P1) 🎯 MVP

**Goal**: 工数、案、発行（番号・写し・売上の仕訳を1トランザクション）、状態と残額、一覧の基本形、取消、印刷用の画面

**Independent Test**: 時間単価型で工数を入れて発行し、金額・番号・期限が正しく、同じ金額の売掛金／売上高の仕訳が1件だけ登録され、一覧に「未入金」で並び、印刷用の画面の title が請求番号。US2 の部品（消し込みの書き込み、期限切れ、未回収の合計）がなくても成り立つ

- [ ] T010 [US1] テスト先行で工数と案を実装する（R3・R7・R8・R10、§1.3、FR-005・006・016、H:§3.1〜§3.3）。`packages/domain/src/invoicing/draft.ts` の `buildInvoiceDraft({ terms, partner, halfHours, month, settings, today, ctx })`（時間単価型は工数 × 単価の1行〔品名 `{M}月分 {既定の品名}`、数量 = 工数、単位 `時間`〕、月額定額型は月額の1行、工数なし・0 の時間単価型は `skipped`、`issueDate` = 今日、`salesDate` = 対象月の末日、`dueDate`、明細の税区分は `defaultTaxCategory`（計上日、売上の科目）から、`taxDisplay` は計上日が免税なら `inclusive_only`〔R10〕、同じ取引先・対象月の取消でない請求書があれば警告 `INVOICE_DUPLICATE_MONTH`）。`usecases/invoicing.ts` に `getWorkHours`・`saveWorkHours`（時間単価型の有効な取引先だけ。`work_hours` の監査）・`draftInvoices`（条件がなければ `BILLING_TERMS_MISSING`、使用停止の取引先は対象外）。`InvoicingStore` に工数と「取引先・対象月の有効な請求書」の読み取りを足す（ポートと実装と偽物を同時に）。ルート H:§3.1〜§3.3。テスト `packages/domain/test/invoicing/draft.test.ts`（US1 Acceptance 1・2、Edge Case の 0 時間・1 円未満、免税の表示、重複の警告は取消済みを数えない）、`packages/db/test/invoicing-work-hours.test.ts`、`apps/server/test/invoicing.drafts.api.test.ts`（`1.25` が `VALIDATION`、偽の時計で `issueDate`）
- [ ] T011 [P] [US1] テスト先行で状態と残額の純関数を実装する（R14、INV-33 の状態の部分、FR-020）。`packages/domain/src/invoicing/status.ts` の `invoiceStatus(invoice, payments)`（`voided` / `paid` / `partial` / `unpaid` と `paid`〔充当額の合計〕・`remaining`。充当額 = 入金額 + 手数料、取消済みの消し込みは数えない）。`packages/domain/src/index.ts` から export。テスト `packages/domain/test/invoicing/status.test.ts`（消し込みなしで `unpaid`・`remaining = total`、取消の請求書は `voided`、取消済みの消し込みを数えない、一部入金と全額入金）。期限切れの判定 `isOverdue` は US2（T017）。`invoicing-payments.property.test.ts` の INV-33 は消し込みの書き込みと同じ T017
- [ ] T012 [US1] テスト先行で発行を実装する（R6・R9・R10・R11・R14、§1.4・§1.5、INV-30・31・32・38、FR-008〜013・015・016、H:§3.4・§3.6・§6.1）。`packages/domain/src/invoicing/journal-drafts.ts` の `invoiceJournalDraft`（借方 売掛金 `1030` に合計1行、貸方 売上高 `4010` を税区分ごとに1行、全行に取引先、摘要 `請求書 <番号>`、科目はコード定数 `INVOICING_ACCOUNT_CODES` で引く）。`usecases/invoicing.ts` の `issueInvoice(deps, input, today)`: 検査（発行者の設定 → `INVOICE_ISSUER_INCOMPLETE`、取引先の使用停止 → `PARTNER_INACTIVE`、重複で `confirmDuplicate` なし → `INVOICE_DUPLICATE_MONTH`、明細の数量・単価と金額の一致 → `VALIDATION`）→ `createJournal(…, { source: "invoice" })`（期間の検査は 001 が `PERIOD_CLOSED`・`OUT_OF_PERIOD` で、消費税の設定の検査は `TAX_SETTING_GAP`・`TAX_METHOD_UNSUPPORTED` で返す。そのまま返し、H:§3.4 のエラーに載せる）→ `next_seq` を読んで +1 → `invoices`（写し: 宛名は `billing_name` か取引先名、敬称は `honorific` か `御中`、`issuer_json`、`tax_display`、`due_date`）→ `invoice_items`（`tax_rate` は計上日の税率）→ 監査、の順（R9。番号の読み取り以降の失敗は `RollbackError`）。`InvoicingStore` に請求書・明細の書き込みと読み取り、消し込みの読み取り（`listPayments(invoiceId)`: 取消でないものと取消済みを区別して返す。書き込みは US2 の T017）を足す（ポート・実装・偽物を同時に）。`InvoiceDetail`（H:§3.6）の `status`・`paid`・`remaining`・`payments` は T011 の `invoiceStatus` と `listPayments` で作る（`overdue` は US2 まで偽）。ルート H:§3.4・§3.6・§6.1（`GET /invoices` は T013）。テスト: `packages/domain/test/invoicing-issue.property.test.ts`（ジェネレーター `packages/domain/test/invoicing-arbitraries.ts`〔条件・工数・明細・税の設定・発行の列〕。INV-30: 合計 = Σ明細 = 借方 売掛金 = Σ貸方 売上高、税区分ごとの `tax_amount` = 税率ごとの税額、取引先の一致。INV-31: `seq`・番号が重複せず発行の順に増え `next_seq > max(seq)`。INV-32: 偽物の UnitOfWork で各書き込みの段階に障害を注入すると、請求書と仕訳の片方だけが残らず `next_seq` も進まない。INV-38: 発行の後に設定・条件・工数・取引先を任意に変えても詳細が変わらない）、`packages/db/test/invoicing-issue.test.ts`（実 DB で明細の挿入に失敗させると仕訳も番号も残らない。トリガー・UNIQUE の検査は T002）、`apps/server/test/invoicing.issue.api.test.ts`（201 と仕訳、`INVOICE_DUPLICATE_MONTH` の 409 と `confirmDuplicate` での発行、締め済みの計上日の 409、発行者の未設定の 422、消費税の設定の空白の計上日で `TAX_SETTING_GAP` の 422・仕訳も請求書も残らない、`GET /invoices/:id` の `status`・`remaining`、`GET /journals/:id/origin`）
- [ ] T013 [US1] テスト先行で請求書の一覧の基本形を実装する（R14、FR-022 の一部、H:§3.5 の基本形）。`usecases/invoicing.ts` の `listInvoices(deps, { partnerId?, month? }, today)`（発行日の降順。各行の `status`・`paid`・`remaining` は T011 の `invoiceStatus` と T012 の `listPayments`。`overdue` は偽、`outstandingByPartner` は `[]`。期限切れの判定・`status` の絞り込み・取引先ごとの未回収の合計は US2 の T018）。`InvoicingStore` に請求書の一覧の読み取り（取引先・対象月の絞り込み）を足す（ポート・実装・偽物を同時に）。ルート H:§3.5（`partnerId`・`month` だけ）を `routes/invoicing.ts` に足す。テスト `packages/domain/test/invoicing/list.test.ts`（絞り込み、取消の請求書は `voided`、発行日の降順）、`apps/server/test/invoicing.list.api.test.ts`（発行した請求書が `unpaid`・`remaining = total` で並ぶ、`partnerId`・`month` の絞り込み）
- [ ] T014 [US1] テスト先行で請求書の取消を実装する（R12、§3、INV-32、FR-014、H:§3.7）。`journal-drafts.ts` の `reversalDraft(journal, today)`（貸借を逆に、税区分・取引先・補助科目は元の行の値、`correctsJournalId` = 元の仕訳）。`voidInvoice(deps, invoiceId, { reason }, today)`: `checkReason` → 取消済みは `INVOICE_VOIDED`、取消でない消し込みがあれば `INVOICE_HAS_PAYMENTS`（T012 の `listPayments` で読む。消し込みを作る処理は US2 の T017 なので、テストは `invoice_payments` の行を直接挿入して作る）→ 元の仕訳の期間が未締めなら `voidJournal(…, { linked: true })`、締め済みなら `createJournal(reversalDraft, { source: "invoice" })`（今日の期間がなければ 001 のエラー）→ 請求書に `voided_at`・`void_reason`・`void_journal_id` → 監査。テスト `packages/domain/test/invoicing/void.test.ts`（US1 Acceptance 7・8、番号を再利用しない、締め済みの元の仕訳が変わらない）、`packages/domain/test/invoicing-void.property.test.ts`（INV-32 の取消: `invoicing-arbitraries.ts` の発行の列に取消を足し、偽の UnitOfWork で `voidJournal`／訂正仕訳の後の各書き込みの段階に障害を注入すると、請求書の取消の列と仕訳の取消〔または訂正仕訳〕の片方だけが残らない）、`apps/server/test/invoicing.void.api.test.ts`
- [ ] T015 [US1] テスト先行で web の工数・案・発行・一覧・詳細を作る（FR-005〜016、H:§3）。`apps/web/src/features/invoicing/` に `WorkHoursTable.tsx`（対象月、取引先ごとの時間、0.5 単位の入力）、`InvoiceDraftList.tsx`・`InvoiceDraftEditor.tsx`（明細の追加・修正・削除〔最大5行〕、**発行日**〔既定は今日〕と**売上の計上日**〔既定は対象月の末日〕の入力〔FR-009〕、合計の再計算は表示だけで、金額の計算は server の応答の値か `itemAmount` と同じ式。重複の警告の確認）、`InvoiceList.tsx`（番号・取引先・対象月・合計・状態・残額の表示と、取引先・対象月の絞り込み。状態の絞り込み・期限切れの印・取引先ごとの未回収は US2 の T019）、`InvoiceDetail.tsx`（写しの表示、取消〔理由〕、売上の仕訳へのリンク）。`apps/web/src/routes/e/$entityId/work-hours.tsx`、`invoices/index.tsx`・`new.tsx`・`$invoiceId.tsx`。仕訳の詳細（`routes/e/$entityId/journals/` の既存の詳細）に `GET /journals/:id/origin` の出所のリンクを足す。`mock-api.ts` に `GET /work-hours`・`GET /invoices`（`invoices: []`、`outstandingByPartner: []`）・`GET /journals/:id/origin`（`origin: null`）の既定の応答を足す。テスト `apps/web/test/routes/work-hours.test.tsx`・`invoices-new.test.tsx`・`invoice-detail.test.tsx`（`INVOICE_ISSUER_INCOMPLETE` で設定へ案内、`PERIOD_CLOSED`・`TAX_SETTING_GAP` の文言、発行日・売上の計上日の既定値と変更が発行の入力に載る、`journal-detail.test.tsx` に出所のリンク）
- [ ] T016 [P] [US1] テスト先行で印刷用の画面を作る（R2、FR-011・012、SC-005）。`apps/web/src/features/invoicing/InvoicePrint.tsx`・`print.css`（`@page { size: A4 }`、A4 縦1枚、`@media print` で画面の要素を隠す。003 の `features/blue-return/print.css` の書き方）、`apps/web/src/routes/e/$entityId/invoices/$invoiceId.print.tsx`。宛名と敬称、発行者（屋号は設定時だけ）、番号、発行日、支払期限、明細、合計、振込先、`tax_display = separate` のときだけ税率ごとの税抜・税額・税込、登録番号は設定時だけ。開いている間 `document.title` = 請求番号、離れると元に戻す。詳細の画面に「印刷・PDF に保存」。テスト `apps/web/test/routes/invoice-print.test.tsx`（title、別記・税込のみの切り替え、登録番号の有無）

**Checkpoint**: 工数 → 案 → 発行 → 印刷 → 取消が server と web で動く（MVP）。`pnpm vitest run --project domain`、`--project db`、`--project server`、`--project web` が通る

---

## Phase 5: User Story 2 - 入金を売掛金に消し込む (Priority: P1)

**Goal**: 消し込み（手数料の差額を含む）の書き込みと取消、期限切れ、取引先ごとの未回収、状態での絞り込み（状態と残額の計算・一覧の基本形は US1 の T011・T013）

**Independent Test**: 2件を発行し、全額と手数料差引で消し込むと売掛金が 0、差額が支払手数料、期限切れの区別

- [ ] T017 [US2] テスト先行で消し込みの書き込み・取消と期限切れの判定を実装する（R12・R14、§1.6・§3、INV-32・33・34、FR-017〜021）。`packages/domain/src/invoicing/status.ts`（T011）に `isOverdue(invoice, remaining, today)`（残額 > 0 かつ `today > due_date`。取消の請求書は偽）を足す。`journal-drafts.ts` の `paymentJournalDraft`（借方 入金先〔補助科目〕に入金額、手数料 > 0 なら借方 支払手数料 `5250`、貸方 売掛金に充当額、全行に取引先、日付は入金日）。`usecases/invoicing.ts` の `recordPayment`（取消済みの請求書は `INVOICE_VOIDED`、`treatDifferenceAsFee` で手数料 = 残額 − 入金額〔0 以下は `VALIDATION`〕、充当額 > 残額は `PAYMENT_EXCEEDS_BALANCE`、`createJournal(…, { source: "payment" })` → `invoice_payments` → 監査）と `voidPayment`（`PAYMENT_NOT_FOUND`・`PAYMENT_VOIDED`、未締めは `voidJournal(…, { linked: true })`、締め済みは T014 の `reversalDraft` の訂正仕訳）。`TAX_SETTING_GAP`・`TAX_METHOD_UNSUPPORTED` は 001 の検証のものをそのまま返す。`InvoicingStore` に消し込みの書き込み（挿入、取消の列の更新）を足す（読み取りは T012 の `listPayments`。ポート・実装・偽物を同時に）。テスト `packages/domain/test/invoicing-payments.property.test.ts`（`invoicing-arbitraries.ts` に発行・消し込み・取消の操作列を足す。INV-33: 充当額の合計 ≤ 合計、状態が残額だけで決まる。INV-34: 任意の操作列の後、取引先ごとに `invoice`・`payment` の仕訳〔訂正仕訳を含む、取消でない〕の売掛金の残高 = 取消でない請求書の残額の合計。INV-32: 偽の UnitOfWork で、`createJournal`／`voidJournal`・訂正仕訳の後の各書き込みの段階に障害を注入すると、消し込み〔または取消の列〕と仕訳の片方だけが残らない）、`packages/domain/test/invoicing/payments.test.ts`（US2 Acceptance 1〜4・6、`INVOICE_HAS_PAYMENTS` で請求書の取消が止まり消し込みの取消の後に通る、`isOverdue` の境目〔支払期限の当日は偽、翌日は真〕）、`packages/db/test/invoicing-payments.test.ts`（実 DB で消し込みの挿入に失敗させると入金の仕訳も残らない。トリガーの検査は T002）
- [ ] T018 [US2] テスト先行で H:§4.1・§4.2 を `routes/invoicing.ts` に足し、T013 の `listInvoices` に期限切れの判定（`InvoiceSummary.overdue`）、`status` の絞り込み（`overdue` を含む）、`outstandingByPartner`（H:§3.5。FR-020・022）を足す。テスト `apps/server/test/invoicing.payments.api.test.ts`（201 と複合仕訳、`PAYMENT_EXCEEDS_BALANCE` の 422、偽の時計で期限切れと `status=overdue` の絞り込み、取引先ごとの未回収、消し込みの取消で残額が戻る）
- [ ] T019 [US2] テスト先行で web の消し込みと一覧を作る（FR-017〜022）。`apps/web/src/features/invoicing/PaymentForm.tsx`（入金日、入金額、入金先の科目・補助科目、差額を「振込手数料」として扱う、残額の表示）、`InvoiceList.tsx`（T015）に状態の絞り込み・期限切れの印・取引先ごとの未回収、`InvoiceDetail.tsx` に消し込みの一覧と取消。テスト `apps/web/test/routes/invoices-payments.test.tsx`（手数料の差額の表示、`PAYMENT_EXCEEDS_BALANCE` の文言、期限切れの区別）

**Checkpoint**: 発行と消し込みで、帳簿の売掛金と未回収が一致する（SC-002）

---

## Phase 6: User Story 3 - 毎月決まった仕訳を自動で登録する (Priority: P2)

**Goal**: 定期仕訳の定義、回の計画、起動時と1時間ごとの判定、重複なし、知らせ

**Independent Test**: 毎月 25 日・開始 8 月の定義で、時計を 10 月 26 日にして起動すると 8・9・10 月の3件、再起動で増えない

- [ ] T020 [P] [US3] テスト先行で回の計画の純関数を実装する（R8・R17、INV-35 の純関数の部分）。**T006 の `clampDay` を使う**（T006 が先）。`packages/domain/src/recurring/schedule.ts` の `scheduledDate(month, day)`（`clampDay` を使う）、`due.ts` の `planRecurringRuns({ def, today, doneMonths, ctx })` → `{ post, blocked }`（対象は `start_month`〜`min(end_month, 今日の月)` で予定日 ≤ 今日、`doneMonths` にない月。`paused` は空。001 の `validateJournal`・`checkPeriod` を通し、`PERIOD_CLOSED`・`OUT_OF_PERIOD`・`ACCOUNT_INACTIVE`・`ACCOUNT_NOT_FOUND` と取引先の使用停止 `PARTNER_INACTIVE` は `blocked`。`validateJournal` が返す `TAX_SETTING_GAP`・`TAX_METHOD_UNSUPPORTED`・補助科目の停止〔`VALIDATION`〕は理由 `JOURNAL_INVALID` の `blocked`〔元のコードを `details.code` に持つ〕。H:§5.8）。テスト `packages/domain/test/recurring-plan.property.test.ts`（ジェネレーター `packages/domain/test/recurring-arbitraries.ts`。任意の定義と今日で、`post` と `blocked` は互いに素で `doneMonths` と重ならず、予定日はすべて今日以前、`post ∪ blocked ∪ doneMonths` が対象の月をすべて覆う）、`recurring/schedule.test.ts`（US3 Acceptance 1・3: 末日〔31〕 → 2 月末）、`recurring/due.test.ts`（税設定の空白の月・未対応の計算方法・停止中の補助科目の行が `JOURNAL_INVALID` の `blocked` になり `post` に入らない）
- [ ] T021 [US3] テスト先行で定期仕訳のユースケースと永続化を実装する（R16・R17・R19・R20・R21・R23、§1.7〜§1.9・§3、INV-35、FR-023〜029）。`packages/domain/src/usecases/recurring.ts`: `createRecurring`・`updateRecurring`（`version` の `VERSION_CONFLICT`、行の全件置き換え、開始月の予定日で `validateJournal` を通す）・`pauseRecurring`・`resumeRecurring`（`start_month = max(start_month, fromMonth)`）、保存・再開で今日以前に登録される回が1件以上あり `confirm` がなければ `RECURRING_CONFIRM_REQUIRED`（`details: { count, months }`）、`skipRecurringRun`（予定日が今日以前で `posted`・`skipped` でない回〔`blocked` を含む未登録の回〕。理由つきで `skipped` を保存。対象外の月は `VALIDATION`。FR-027）、`postDueRecurring(deps, today)`（定義ごとに `planRecurringRuns` → 回ごとに1トランザクションで `createJournal(…, { source: "recurring" })` → `recurring_runs`〔`posted`〕。UNIQUE の違反は例外で仕訳も巻き戻す）、`recurringStatus(deps, today)`（未確認の `posted` と `blocked`）、`acknowledgeRuns`。監査は `recurring_journal`・`recurring_run`（`create`・`update`・`pause`・`resume`・`skip`・`acknowledge`）を T004 の `appendRecurringAudit` で同じトランザクションに残す。`RecurringStore` のメソッド（定義・行・回の読み書き）をポート・`DrizzleRecurringStore`・偽物に同時に足す。テスト `packages/domain/test/recurring-ops.property.test.ts`（INV-35: 任意の定義の集合と、起動の日の列〔同じ日の重複、停止・再開・変更・締め・締めの解除を挟む〕で `postDueRecurring` を繰り返すと、各（定期仕訳, 月）の `posted` は高々1件、最後の判定の後は `active` の定義の、再開後の `start_month` 以降・`end_month` 以前・予定日が今日以前の各月が `posted`・`skipped`・`blocked` のどれか1つ、仕訳の日付が `scheduledDate`、登録済みの仕訳を取り消しても再登録されない）、`packages/domain/test/recurring/usecases.test.ts`（US3 Acceptance 2・4・5・6・8、再開で停止の間の月を登録しない・再開の月より前の回は対象外、保存と再開の `RECURRING_CONFIRM_REQUIRED`、未登録の回の `skip`）、`packages/db/test/recurring-repository.test.ts`（実 DB で同じ回の登録を2回走らせても仕訳は1件だけ、定義と行の保存と読み戻しの往復。トリガー・UNIQUE の検査は T002）
- [ ] T022 [US3] テスト先行で判定の起動とルートを実装する（R18・R22、H:§5、FR-024・028）。`apps/server/src/lib/recurring-scheduler.ts` の `startRecurringScheduler({ entities, openUnitOfWork, clock, intervalMs })`（backup-scheduler.ts と同じ形: 既定 1 時間、`timer.unref()`、同時に1回だけ、例外はログだけで名前以外を出さない、registry の全事業体を順に、1つの失敗でほかを止めない）。`apps/server/src/lib/startup.ts` の `startBackgroundServices` に足して起動時に1回すぐ `tick`、`apps/server/src/main.ts` で `deps.ts` の `clock` を渡す。`routes/recurring.ts` に H:§5.1〜§5.9（`/status`・`/acknowledge` を `/:id` より先に登録。5.2・5.4・5.6 の後にその事業体の `postDueRecurring` を呼んで `posted` を返す）。テスト `apps/server/test/recurring-scheduler.test.ts`（偽の時計で 2026-10-26 に `tick` → 8・9・10 月の 25 日付の3件〔`source = recurring`〕、もう一度 `tick`・作り直したスケジューラーの `tick` で増えない、1つの事業体の DB の失敗でほかの事業体が登録される）、既存の `apps/server/test/backup-startup.test.ts` を新しい引数に直す、`apps/server/test/recurring.api.test.ts`（409 `RECURRING_CONFIRM_REQUIRED` と `confirm` での保存、`VERSION_CONFLICT`、`status` の未確認と `blocked`〔`JOURNAL_INVALID` と `details.code` を含む〕、`acknowledge` の後に未確認から消える、`skip`、`dayOfMonth` 29・30 の `VALIDATION`）
- [ ] T023 [US3] テスト先行で web の定期仕訳の画面と知らせを作る（FR-023〜029）。`apps/web/src/features/recurring/RecurringList.tsx`・`RecurringForm.tsx`（001 の `JournalForm` の行の入力を流用できるか確かめる。予定日は 1〜28 と「末日」〔= 31〕、開始月・終了月、`RECURRING_CONFIRM_REQUIRED` の件数を示して確認）・`RecurringNotice.tsx`（事業体の画面の上部に、未確認の自動登録の件数と一覧、`blocked` の回〔理由の文言。`JOURNAL_INVALID` は元のコードで案内〕と、登録できなかった回・未登録の回の「この回は登録しない」、「確認した」）・`api.ts`、`apps/web/src/routes/e/$entityId/recurring/index.tsx`・`new.tsx`・`$recurringId.tsx`（停止・再開〔再開の月と、`RECURRING_CONFIRM_REQUIRED` の件数の確認〕、登録の記録）。`mock-api.ts` に `GET /recurring-journals`（空）と `GET /recurring-journals/status`（`unacknowledged: []`、`blocked: []`）の既定の応答を足し、事業体の画面を描く既存のテストが落ちないことを確かめる。テスト `apps/web/test/routes/recurring.test.tsx`（作成と確認、知らせの表示と確認、停止・再開）

**Checkpoint**: 定期仕訳が起動時と1時間ごとに、漏れなく重複なく登録される（SC-004）

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T024 文書を更新する: `AGENTS.md` に「請求と定期仕訳（005）」の節（層の表: `packages/domain/src/invoicing/`・`recurring/`、`usecases/invoicing.ts`・`recurring.ts`、`packages/db/src/invoicing-repository.ts`・`recurring-repository.ts`、`apps/server/src/routes/invoicing.ts`・`recurring.ts`・`lib/today.ts`・`lib/recurring-scheduler.ts`、`apps/web/src/features/invoicing/`・`recurring/` と routes。規約: 書く順序〔R9〕、請求・入金の仕訳は `JOURNAL_LINKED` で守る〔R13〕、「今日」は `todayOf`〔R22〕、科目のコード〔R10〕）、`docs/adr/0008-invoice-journal-linkage.md`（請求・入金と仕訳の結びつけ方: 1トランザクション、写し、通常の訂正・取消の禁止、取消の規則。書式は `docs/adr/0001-sqlite-driver.md`）
- [ ] T025 **（メイン・利用者）** quickstart.md の §2・§3 を利用者の端末で手動確認する（`TREBUCHET_DATA_DIR="$PWD/.tmp/quickstart-005" pnpm dev`。server の起動は利用者、ブラウザの操作は implementer に playwright の MCP の `browser_snapshot` で行わせる。PDF の体裁〔SC-005〕と時間〔SC-001〕は利用者が確かめる）。画面の文言と手順を quickstart.md に合わせて直す。結果の数値はリポジトリに書かない
- [ ] T026 `apps/web/e2e/invoicing.spec.ts` を書く（発行者の設定 → 条件 → 工数 → 発行 → 印刷用の画面の title → 消し込み → 状態が「入金済み」。004 の `apps/web/e2e/helpers/` の登録とサインインの手順を使い、データは `.tmp/`）。実行は利用者の端末（`pnpm --filter @trebuchet/web e2e`）
- [ ] T027 **（メイン）** 全体の検証: `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm --filter @trebuchet/web build`。E2E は利用者の端末で。bench は追加しない（plan の Performance Goals: 件数が小さい）

---

## Dependencies & Execution Order

### Phase Dependencies

- Foundational（T001〜T005）→ US4（T006〜T009）→ US1（T010〜T016）→ US2（T017〜T019）→ US3（T020〜T023）→ Polish（T024〜T027）
- T001（エラーコードと型）は T003 以降のすべての前提。T002（表）→ T004（UnitOfWork）。T003（001 の変更）は T012・T014・T017・T021 の前提。T005（`createApp` の clock と空のルート、`JOURNAL_LINKED` の details の補完）は T008 以降のルートの前提
- **T006 は T020 の前提**（`clampDay` を `scheduledDate` が使う）。US3 を US4 より先にする場合も、T006 は先に行う

### User Story Dependencies

- **US4**: Foundational の後。US1 の前提（発行者の設定・条件・純関数）
- **US1**: US4 の後。T010（案）→ T011（状態と残額の純関数）→ T012（発行。T011 を使う）→ T013（一覧の基本形。T011・T012 を使う）→ T014（取消。`reversalDraft` は T017 も使う。T012 の `listPayments` を使う）→ T015（web）。T016 は T012 の詳細の API の後なら T015 と別ファイル（[P]）。US1 は US2 の部品なしで完結する（チェックポイントは US1 までで成り立つ）
- **US2**: US1 の後（請求書がないと消し込めない）。T017（消し込みの書き込み・取消、期限切れの判定。T011 の `invoiceStatus`・T012 の `listPayments`・T014 の `reversalDraft` を使う）→ T018（ルートと一覧の拡張。T013 の `listInvoices` を使う）→ T019
- **US3**: Foundational の後なら US1・US2 と独立（001 の仕訳と T003 の `source` だけに依存）。優先度 P2 のため最後に置く。T020 は T006 の `clampDay` を使う
- Polish: T026 の E2E は US1・US2 の画面が揃った後

### Within Each User Story

- テスト → スキーマ → ドメイン → db → server → web
- テストが旧コードで落ちることを確かめてから実装する（部下が赤の確認を飛ばしたら、メインが `git stash` で確かめる）

### Parallel Opportunities

- T001 と T002 は別ファイル（[P]）、T006 は US4 のほかのタスクと、T011 は US1 のほかのタスクと、T016 は T015 と、T020 は T021 と別ファイル（[P]）。実行は順番に行う

## Implementation Strategy

### MVP First（Foundational ＋ US4 ＋ US1）

1. Foundational（T001〜T005）
2. US4（T006〜T009）: 設定と条件がないと請求書を作れない
3. US1（T010〜T016）: 工数 → 案 → 発行 → 印刷 → 取消。今の請求書のサービスの代わりになる最小（SC-005、SC-002 の前半）
4. 合成の事業体で、発行した請求書の合計と売上の仕訳が一致することを確かめる（INV-30）

### Incremental Delivery

1. MVP → US2（消し込み）で売掛金の残高が合う（SC-002 の後半、SC-006）
2. US3（定期仕訳）は独立して足せる（P2）
3. フェーズの区切りごとにコミットし（メッセージにタスク ID）、`/usage` を控える

## Notes

- 部下への渡し方: 関連するタスクのまとまり（同じユーザーストーリーのテストと実装、同じファイルを触るタスク）を1体に渡す。タスクの行と、参照する節（R・§・INV・H:§）だけを渡す
- implementer に渡す: メインが行う T025・T027 以外のすべて
- implementer-hard の候補: T012（発行の全部か無か、INV-30〜32 の性質テストの設計）と T021（INV-35 の操作列の性質テスト）。まず implementer に渡し、整合性の判断が要ると報告されたときだけ implementer-hard に回す
- 完了の [X] はメインがまとめて付ける
- サンドボックスではローカルのポートを開けない。dev サーバー・E2E の確認（T025・T026 の実行・T027 の E2E）は利用者の端末で行う
