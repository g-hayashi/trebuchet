# Data Model: 定期仕訳と工数・請求

**Feature**: [spec.md](./spec.md) | **Research**: [research.md](./research.md) | **Date**: 2026-10-24

事業体の DB（tenant）に 10 表を足す（`packages/db/src/schema/tenant.ts`）。マイグレーションは `packages/db/drizzle/tenant/0005_invoicing.sql`（`drizzle-kit generate --name invoicing --config drizzle.tenant.config.ts`、生成後に各表の `);` を `) STRICT;` に置き換える）と、`0006_invoicing_integrity.sql`（`--custom --name invoicing_integrity`。§2 のトリガー）。registry は変えない。金額は円の整数、日付は `YYYY-MM-DD`、月は `YYYY-MM`、日時は ISO 8601（UTC）、主キーは UUIDv7。

## 1. 表（tenant）

### 1.1 `invoice_settings`（FR-003, FR-004。R5・R6）

| 列 | 型 | 制約 |
|---|---|---|
| `id` | integer | PK、`CHECK (id = 1)`（1行だけ） |
| `issuer_name` | text | NOT NULL（空文字は未設定として扱う） |
| `trade_name` | text | NULL 可（屋号） |
| `address` / `contact` / `bank_account` | text | NOT NULL（振込先は複数行の自由記述） |
| `registration_number` | text | NULL 可。`CHECK (registration_number GLOB 'T[0-9]*' AND length = 14)` |
| `tax_display` | text | `separate`（別記）/ `inclusive_only`（税込のみ）。CHECK。既定 `inclusive_only` |
| `next_seq` | integer | `>= 1`。既定 1 |
| `updated_at` | text | |

- 行がない・`issuer_name`・`address`・`contact`・`bank_account` のどれかが空なら発行できない（`INVOICE_ISSUER_INCOMPLETE`）

### 1.2 `partner_billing_terms`（FR-001, FR-002。R4・R8）

| 列 | 型 | 制約 |
|---|---|---|
| `partner_id` | text | PK、FK → `partners.id` |
| `billing_type` | text | `hourly` / `monthly`（CHECK） |
| `unit_price` | integer | `hourly` なら NOT NULL かつ `> 0`、`monthly` なら NULL（CHECK） |
| `monthly_amount` | integer | `monthly` なら NOT NULL かつ `> 0`、`hourly` なら NULL（CHECK） |
| `due_months_after` | integer | `BETWEEN 0 AND 12`。既定 1 |
| `due_day` | integer | `BETWEEN 1 AND 28 OR due_day = 31`（31 = 末日。29・30 は不可）。既定 31 |
| `default_item_name` | text | `length > 0` |
| `billing_name` | text | NULL 可（請求書の宛名。NULL なら取引先名） |
| `updated_at` | text | |

- 敬称は `partners.honorific`（001）を使う。NULL なら請求書は `御中`
- 取引先が使用停止なら、案の対象から外す（発行済みの請求書と消し込みには影響しない）

### 1.3 `work_hours`（FR-005。R7）

| 列 | 型 | 制約 |
|---|---|---|
| `partner_id` | text | FK → `partners.id` |
| `target_month` | text | `YYYY-MM`（`GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'`） |
| `half_hours` | integer | `>= 0`（0.5 時間 = 1） |
| `updated_at` | text | |

- PK（`partner_id`, `target_month`）。上書きで保存する（発行済みの請求書は明細の写しを持つので影響しない）

### 1.4 `invoices`（FR-008〜FR-016。R6・R11・R12）

| 列 | 型 | 制約 |
|---|---|---|
| `id` | text | PK |
| `invoice_no` | text | NOT NULL UNIQUE（`YYYYMMDD-NNN`） |
| `seq` | integer | NOT NULL UNIQUE、`>= 1` |
| `partner_id` | text | FK → `partners.id` |
| `target_month` | text | `YYYY-MM` |
| `issue_date` / `sales_date` / `due_date` | text | NOT NULL。`due_date >= issue_date` は検査しない（過去の分の発行があり得る） |
| `recipient_name` | text | `length > 0`（写し） |
| `recipient_honorific` | text | `様` / `御中`（写し） |
| `issuer_json` | text | NOT NULL（写し: `{ issuerName, tradeName, address, contact, bankAccount, registrationNumber }`） |
| `tax_display` | text | `separate` / `inclusive_only`（写し。免税の期間は `inclusive_only`。R10） |
| `total` | integer | `> 0 AND < 10^12`（税込の合計 = Σ明細の金額。INV-30） |
| `journal_id` | text | NOT NULL UNIQUE、FK → `journals.id`（売上の仕訳） |
| `created_at` | text | |
| `voided_at` / `void_reason` | text | NULL 可。CHECK: 両方 NULL か両方 NOT NULL |
| `void_journal_id` | text | NULL 可、FK → `journals.id`（締め済みの年度の取消で起票した訂正仕訳） |

- 索引: `(partner_id, target_month)`、`(due_date)`
- 写しの列は発行後に変えない。更新できるのは `voided_at`・`void_reason`・`void_journal_id` を NULL から一度だけ（§2）

### 1.5 `invoice_items`（FR-006, FR-007, FR-012。R7）

| 列 | 型 | 制約 |
|---|---|---|
| `id` | text | PK |
| `invoice_id` | text | FK → `invoices.id` |
| `line_no` | integer | `BETWEEN 1 AND 5`。UNIQUE（`invoice_id`, `line_no`） |
| `name` | text | `length > 0` |
| `quantity_halves` | integer | NULL 可、`> 0`（数量 × 2） |
| `unit` | text | NULL 可（`時間`、`式` など） |
| `unit_price` | integer | NULL 可、`> 0` |
| `amount` | integer | `> 0 AND < 10^12`。数量と単価がともにあれば `amount = (quantity_halves * unit_price) / 2`（SQLite の整数の除算 = 切り捨て。CHECK） |
| `tax_category` | text | FK → `tax_categories.code`（計上日で決めた値。R10） |
| `tax_rate` | integer | NULL 可（課税の区分のときの税率。対象外は NULL） |

- 更新・削除を禁止（§2）

### 1.6 `invoice_payments`（FR-017〜FR-021。R14）

| 列 | 型 | 制約 |
|---|---|---|
| `id` | text | PK |
| `invoice_id` | text | FK → `invoices.id` |
| `received_on` | text | NOT NULL |
| `amount` | integer | `> 0`（入金額） |
| `fee_amount` | integer | `>= 0`（支払手数料として扱った差額） |
| `deposit_account_id` | text | FK → `accounts.id` |
| `deposit_sub_account_id` | text | NULL 可、FK → `sub_accounts.id` |
| `journal_id` | text | NOT NULL UNIQUE、FK → `journals.id` |
| `created_at` | text | |
| `voided_at` / `void_reason` / `void_journal_id` | text | `invoices` と同じ |

- 充当額 = `amount + fee_amount`。索引 `(invoice_id)`。削除を禁止、更新は取消の列だけ（§2）

### 1.7 `recurring_journals`（FR-023, FR-026。R16・R20）

| 列 | 型 | 制約 |
|---|---|---|
| `id` | text | PK |
| `name` | text | `length > 0`（一覧の表示名） |
| `memo` | text | NULL 可（仕訳の摘要） |
| `day_of_month` | integer | `BETWEEN 1 AND 28 OR day_of_month = 31`（31 = 末日。29・30 は不可。R8） |
| `start_month` | text | `YYYY-MM` |
| `end_month` | text | NULL 可、`>= start_month` |
| `status` | text | `active` / `paused`（CHECK） |
| `version` | integer | `>= 1`（楽観ロック） |
| `created_at` / `updated_at` | text | |

- 物理削除しない（FR-023 は停止まで）

### 1.8 `recurring_journal_lines`（FR-023）

| 列 | 型 | 制約 |
|---|---|---|
| `id` | text | PK |
| `recurring_id` | text | FK → `recurring_journals.id` |
| `line_no` | integer | UNIQUE（`recurring_id`, `line_no`） |
| `side` | text | `debit` / `credit` |
| `account_id` / `sub_account_id` | text | FK（補助は NULL 可） |
| `amount` | integer | `> 0 AND < 10^12` |
| `tax_category` | text | NULL 可（NULL は各回の予定日の既定。R16） |
| `partner_id` | text | NULL 可、FK |
| `description` | text | NULL 可 |

- 定義の変更は行を全件置き換える（`version` +1）。Σ借方 = Σ貸方はドメインで検査（001 の `validateJournal`）

### 1.9 `recurring_runs`（FR-024, FR-025, FR-028。R17・R19・R21）

| 列 | 型 | 制約 |
|---|---|---|
| `id` | text | PK |
| `recurring_id` | text | FK → `recurring_journals.id` |
| `target_month` | text | `YYYY-MM`。**UNIQUE（`recurring_id`, `target_month`）** |
| `status` | text | `posted` / `skipped`（CHECK） |
| `journal_id` | text | `posted` なら NOT NULL、`skipped` なら NULL（CHECK）。UNIQUE、FK → `journals.id` |
| `skip_reason` | text | `skipped` なら NOT NULL |
| `created_at` | text | |
| `acknowledged_at` | text | NULL 可（利用者が確かめた時刻） |

- 登録できない回（`blocked`）は保存しない（R17）。利用者が「この回は登録しない」と確定した回（未登録の回を含む）だけ `skipped` として保存する。削除を禁止、更新は `acknowledged_at` を NULL から一度だけ（§2）
- `blocked` の理由（保存しない計算上の値。契約 §5.8 の `BlockedRun.reason`）: `PERIOD_CLOSED`・`OUT_OF_PERIOD`・`ACCOUNT_INACTIVE`・`ACCOUNT_NOT_FOUND`・`PARTNER_INACTIVE`、および `JOURNAL_INVALID`（001 の `validateJournal` が返す `TAX_SETTING_GAP`・`TAX_METHOD_UNSUPPORTED`・補助科目の停止〔`VALIDATION`〕。元のエラーのコードを `details.code` に持つ。R17）

### 1.10 `invoicing_audit_log`（FR-032。R23）

003 の `closing_audit_log` と同じ列（`id`、`occurred_at`、`target_type`、`target_id`、`action`、`reason`、`before_json`、`after_json`）。`target_type` は `invoice_settings` / `billing_terms` / `work_hours` / `invoice` / `payment` / `recurring_journal` / `recurring_run`、`action` は `create` / `update` / `void` / `pause` / `resume` / `skip` / `acknowledge`（CHECK）。更新・削除を禁止。

## 2. 既存の表の変更とトリガー（`0006_invoicing_integrity.sql`）

| 名前 | 内容 | 根拠 |
|---|---|---|
| `journals_source_insert` / `journals_source_update` | `source NOT IN ('manual','import_freee','invoice','payment','recurring')` なら ABORT（`journals` は作り直さない） | R15 |
| `invoices_no_delete` / `invoice_items_no_delete` / `invoice_payments_no_delete` / `recurring_runs_no_delete` | 削除を ABORT | Constitution I・II |
| `invoices_void_only` / `invoice_payments_void_only` | 取消の列以外の更新、取消済みの行の更新を ABORT | INV-38、R11 |
| `invoice_items_no_update` | 更新を ABORT | INV-38 |
| `recurring_runs_ack_only` | `acknowledged_at` を NULL から付ける以外の更新を ABORT | R19・R21 |
| `invoice_settings_seq_floor` | `NEW.next_seq <= (SELECT max(seq) FROM invoices)` なら ABORT | FR-004、INV-31 |
| `invoicing_audit_log_no_update` / `_no_delete` | 追記のみ | FR-032 |

型の変更: `JournalSource`（domain の `types.ts`、`tenant.ts` の enum。schema には `source` の定義がない）に `invoice`・`payment`・`recurring` を足す。

## 3. 状態遷移

- **請求書**（状態は保存しない。`invoiceStatus`。R14）: 発行 → `unpaid` → （消し込み）→ `partial` → `paid`。消し込みの取消で逆に戻る。`unpaid` のときだけ → `voided`（終端。入金があれば `INVOICE_HAS_PAYMENTS`）。状態の値は `unpaid`・`partial`・`paid`・`voided` の4つ。期限切れは状態ではなく**期限切れの判定**（表示用、残額 > 0 かつ今日 > 支払期限。一覧の絞り込みの値 `overdue` と応答の `overdue` の印に使う）
- **消し込み**: `active` → `voided`（終端）
- **定期仕訳**: `active` ⇄ `paused`（再開で `start_month` を進める。R20）。`end_month` を過ぎても `active` のまま（登録の対象がないだけ）
- **定期仕訳の回**: （計算上）未到来 → 予定日が今日以前で `post`（保存して `posted`）または `blocked`（保存しない）→ 利用者が飛ばすと `skipped`。`posted` → 確かめて `acknowledged_at`

## 4. 不変条件（INV-1〜29 に追加。fast-check で検証。R25）

- **INV-30**: 取消でない各請求書で、`total` = Σ明細の `amount` = 売上の仕訳の借方 売掛金 = Σ貸方 売上高。税区分ごとの貸方の `tax_amount` = その税率の明細の合計に対する `floor(合計 × r / (100 + r))`（請求書の「別記」の税額と同じ）。全行の取引先が請求書の取引先
- **INV-31**: 事業体の中で `seq`・`invoice_no` は重複しない。発行の順に `seq` は狭義に増え、取消した番号は再び使われない。常に `next_seq > max(seq)`
- **INV-32**: 発行・消し込み・取消は全部か無か。任意の段階の失敗（障害の注入）の後、請求書（消し込み）があること ⇔ 対応する仕訳があること、が保たれ、`next_seq` も進まない
- **INV-33**: 各請求書で、取消でない消し込みの充当額の合計 ≤ `total`。状態は残額（`total` − 充当額の合計）だけで決まる（0 なら `paid`、`total` なら `unpaid`、間は `partial`）
- **INV-34**: 任意の発行・消し込み・取消の操作列の後、取引先ごとに「請求・入金に結びつく仕訳（`source` が `invoice`・`payment`、訂正仕訳を含む、取消でない）の売掛金の残高」=「取消でない請求書の残額の合計」（SC-002）
- **INV-35**: 任意の定期仕訳の定義の集合、任意の起動の日の列（同じ日の重複、停止・再開・変更・締めを含む）について、各（定期仕訳, 月）の `posted` の仕訳は高々1件。最後の判定の後、`active` の定義で、再開後の `start_month` 以降、`end_month` 以前（あれば）、予定日が今日以前の各月は `posted`・`skipped`・`blocked` のどれか1つ（漏れなし）。`posted` の仕訳の日付は `scheduledDate(月, day)`（SC-004）
- **INV-36**: （`d` は 1〜28 または 31） `clampDay` は常にその月の 1 日〜末日。`dueDate(month, n, d)` は `month` の n か月後の月にあり、`d >= 末日` なら末日。年をまたいでも同じ（12 月分 + 1 か月 = 翌年 1 月）
- **INV-37**: 明細の金額 = `floor(quantity_halves × unit_price / 2)`（数量と単価があるとき）。別記の税抜の小計 + 税額 = 税込の合計（税率ごと）。すべて整数
- **INV-38**: 発行済みの請求書の写し（宛名、発行者、税の表示、支払期限、明細、合計）は、設定・取引先・条件・工数のどんな変更の後も変わらない
- **INV-39**: `source` が `invoice`・`payment` の仕訳は、請求・入金の取消（R12）以外では訂正・取消されない（`JOURNAL_LINKED`）。訂正元にできるのは同じ `source` の仕訳だけ

## 5. ドメインの関数とポート（tasks で参照する名前）

- 純関数: `formatInvoiceNo(issueDate, seq)`、`itemAmount(quantityHalves, unitPrice)`、`taxBreakdown(items)`、`buildInvoiceDraft({ terms, partner, workHours, month, settings, ctx })`、`invoiceJournalDraft(invoice, items, accounts)`、`paymentJournalDraft(...)`、`reversalDraft(journal, today)`、`invoiceStatus(invoice, payments)`（状態と残額。`voided` / `paid` / `partial` / `unpaid`）、`isOverdue(invoice, remaining, today)`（期限切れの判定）、`clampDay`、`dueDate`、`scheduledDate`、`planRecurringRuns`（R17）
- ポート（`ports.ts`、同期）: `InvoicingStore`（設定・条件・工数・請求書・明細・消し込みの読み書き、`appendInvoicingAudit`、`originOfJournal(journalId)`）、`InvoicingUnitOfWork`（`{ ledger, masters, invoicing }`）、`RecurringStore`（定義・行・回の読み書き、`appendRecurringAudit`）、`RecurringUnitOfWork`（`{ ledger, masters, recurring }`）。監査の表は `invoicing_audit_log` を共有し、それぞれのストアが自分の対象の記録を追記する
- ユースケース: `saveInvoiceSettings`、`saveBillingTerms`、`saveWorkHours`、`draftInvoices`、`issueInvoice`、`voidInvoice`、`recordPayment`、`voidPayment`、`listInvoices`、`createRecurring`、`updateRecurring`、`pauseRecurring`、`resumeRecurring`、`skipRecurringRun`、`postDueRecurring(deps, today)`、`recurringStatus`、`acknowledgeRuns`
- 001 の変更: `createJournal` の `options.source`、`voidJournal`・`correctJournal` の `options.linked`、`checkCorrectsTarget` の `source` の条件（R9・R13）
