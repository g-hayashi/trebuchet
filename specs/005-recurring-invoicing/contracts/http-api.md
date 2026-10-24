# Contract: HTTP API（005-recurring-invoicing）

001 の [http-api.md](../../001-ledger-core/contracts/http-api.md) の規約（ベースパス `/api`、エラー形式、`warnings`、Hono RPC）と、004 の検査（Host → CSRF → 認証。全ルートが要サインイン）を使う。パスはすべて `/entities/:entityId` の下。入出力の正本は `packages/schema/src/invoicing.ts` と `recurring.ts` の Zod 定義。金額は円の整数。工数の入出力は時間の数値（0.5 の倍数）で、保存は半時間の整数（research R7）。

## 1. 追加するエラーコード（14種。`packages/schema/src/errors.ts`、`apps/server/src/errors.ts` の `ERROR_STATUS`）

| HTTP | code | 発生条件 | 要件 |
|---|---|---|---|
| 404 | `INVOICE_NOT_FOUND` | 請求書がない。`details.invoiceId` | FR-014 |
| 404 | `PAYMENT_NOT_FOUND` | 消し込みがない（別の請求書のものを含む） | FR-021 |
| 404 | `RECURRING_NOT_FOUND` | 定期仕訳がない | FR-023 |
| 422 | `BILLING_TERMS_MISSING` | 請求の条件のない取引先の案を求めた | FR-006 |
| 422 | `INVOICE_ISSUER_INCOMPLETE` | 発行者の設定がない・必須の項目が空。`details.fields` | Edge Cases |
| 422 | `PARTNER_INACTIVE` | 使用停止の取引先への発行。定期仕訳の `blocked` の理由にも使う | Edge Cases, FR-027 |
| 409 | `INVOICE_DUPLICATE_MONTH` | 同じ取引先・対象月の有効な請求書があり、`confirmDuplicate: true` がない。`details.invoices`（番号）。案では警告として返す | FR-016 |
| 409 | `INVOICE_VOIDED` | 取消済みの請求書への消し込み・取消 | FR-014 |
| 409 | `INVOICE_HAS_PAYMENTS` | 取消でない消し込みがある請求書の取消。`details.paymentIds` | FR-014 |
| 422 | `PAYMENT_EXCEEDS_BALANCE` | 充当額が残額を超える。`details: { remaining, applied }` | FR-019 |
| 409 | `PAYMENT_VOIDED` | 取消済みの消し込みの取消 | FR-021 |
| 422 | `INVOICE_SEQ_TOO_LOW` | 次の通し番号が発行済みの最大以下。`details.minimum` | FR-004 |
| 409 | `JOURNAL_LINKED` | 請求・入金の仕訳を 001 の訂正・取消・訂正仕訳で直そうとした。`details: { invoiceId, paymentId? }` | R13 |
| 409 | `RECURRING_CONFIRM_REQUIRED` | 保存・再開で今日以前に登録される回があり、`confirm: true` がない。`details: { count, months }` | FR-029 |

既存のコードの再利用: `VALIDATION`（Zod、0.5 の倍数でない工数、明細が0行・6行以上、存在しない取引先・科目は `details.field`）、`PERIOD_CLOSED`・`OUT_OF_PERIOD`（売上の計上日・入金日・取消の訂正仕訳の日付）、`REASON_REQUIRED`、`VERSION_CONFLICT`（定期仕訳。`details: { recurringId, currentVersion }`）、`ACCOUNT_NOT_FOUND`・`ACCOUNT_INACTIVE`、`UNBALANCED`（定期仕訳の定義）。

## 2. 発行者の設定と請求の条件（US4）

| § | メソッド | パス | 入力 | 出力 | 要件 |
|---|---|---|---|---|---|
| 2.1 | GET | `/invoice-settings` | — | 200 `{ settings: InvoiceSettings \| null, minimumNextSeq }` | FR-003, FR-004 |
| 2.2 | PUT | `/invoice-settings` | `{ issuerName, tradeName?, address, contact, bankAccount, registrationNumber?, taxDisplay, nextSeq }` | 200 `{ settings }` / 422 `INVOICE_SEQ_TOO_LOW` | FR-003, FR-004 |
| 2.3 | GET | `/billing-terms` | — | 200 `{ terms: (BillingTerms & { partnerName, honorific, partnerActive })[] }` | FR-001 |
| 2.4 | PUT | `/partners/:partnerId/billing-terms` | `{ billingType, unitPrice?, monthlyAmount?, dueMonthsAfter, dueDay, defaultItemName, billingName? }`（型に合わない金額は `VALIDATION`） | 200 `{ terms }` | FR-001, FR-002 |
| 2.5 | DELETE | `/partners/:partnerId/billing-terms` | — | 204（条件を外す。発行済みの請求書は変わらない） | FR-001 |

敬称は 001 の `PATCH /partners/:partnerId` の `honorific` で直す。

## 3. 工数と請求書（US1）

| § | メソッド | パス | 入力 | 出力 | 要件 |
|---|---|---|---|---|---|
| 3.1 | GET | `/work-hours?month=YYYY-MM` | — | 200 `{ entries: { partnerId, hours }[] }`（時間単価型の有効な取引先。未入力は `hours: null`） | FR-005 |
| 3.2 | PUT | `/work-hours/:month` | `{ entries: { partnerId, hours }[] }`（`hours` は 0 以上・0.5 の倍数） | 200 `{ entries }` | FR-005 |
| 3.3 | POST | `/invoices/drafts` | `{ month, partnerIds? }`（省略で条件のある有効な取引先すべて） | 200 `{ drafts: InvoiceDraft[], skipped: { partnerId, reason: "NO_HOURS" \| "ZERO_HOURS" }[] }`。`InvoiceDraft` = `{ partnerId, targetMonth, issueDate, salesDate, dueDate, items, total, taxDisplay, taxBreakdown, warnings }`（`warnings` に `INVOICE_DUPLICATE_MONTH`）。保存しない（R3） | FR-006, FR-016 |
| 3.4 | POST | `/invoices` | `{ partnerId, targetMonth, issueDate?, salesDate?, items: { name, quantity?, unit?, unitPrice?, amount, taxCategory? }[]（1〜5行）, confirmDuplicate? }`。`issueDate` の既定は今日、`salesDate` は対象月の末日。数量と単価があるとき `amount` は `floor(数量×2×単価/2)` と一致しなければ `VALIDATION` | 201 `{ invoice: InvoiceDetail, journal }` / 409 `INVOICE_DUPLICATE_MONTH` / 422 `INVOICE_ISSUER_INCOMPLETE`・`PARTNER_INACTIVE` / 409 `PERIOD_CLOSED` / 422 `OUT_OF_PERIOD` | FR-008〜FR-013, FR-015 |
| 3.5 | GET | `/invoices?partnerId=&month=&status=` | `status` は `unpaid`・`partial`・`paid`・`voided`・`overdue` | 200 `{ invoices: InvoiceSummary[], outstandingByPartner: { partnerId, partnerName, outstanding, overdue }[] }`。`InvoiceSummary` = `{ id, invoiceNo, partnerId, recipientName, targetMonth, issueDate, dueDate, total, paid, remaining, status, overdue }`（発行日の降順） | FR-020, FR-022 |
| 3.6 | GET | `/invoices/:invoiceId` | — | 200 `InvoiceDetail` = `InvoiceSummary` ＋ `{ salesDate, recipientHonorific, issuer, taxDisplay, items, taxBreakdown: { rate, inclusive, tax, exclusive }[], journalId, voidJournalId, voidedAt, voidReason, payments: PaymentView[] }` | FR-010, FR-011, FR-012 |
| 3.7 | POST | `/invoices/:invoiceId/void` | `{ reason }` | 200 `{ invoice, journal }`（`journal` は取り消した仕訳、または締め済みの年度で起票した訂正仕訳）/ 409 `INVOICE_HAS_PAYMENTS`・`INVOICE_VOIDED` | FR-014 |

- 発行・取消は1トランザクション（research R9）。発行の順序: 検査 → `createJournal`（`source = invoice`）→ 通し番号を進める → 請求書・明細 → 記録
- 印刷用の画面（web の `/e/$entityId/invoices/$invoiceId/print`）は 3.6 だけを使う（research R2）

## 4. 入金の消し込み（US2）

| § | メソッド | パス | 入力 | 出力 | 要件 |
|---|---|---|---|---|---|
| 4.1 | POST | `/invoices/:invoiceId/payments` | `{ receivedOn, amount, depositAccountId, depositSubAccountId?, treatDifferenceAsFee? }`。`treatDifferenceAsFee: true` で手数料 = 残額 − 入金額（> 0 のときだけ。0 以下なら `VALIDATION`） | 201 `{ payment: PaymentView, invoice: InvoiceSummary, journal }` / 422 `PAYMENT_EXCEEDS_BALANCE` / 409 `INVOICE_VOIDED`・`PERIOD_CLOSED` | FR-017〜FR-019 |
| 4.2 | POST | `/invoices/:invoiceId/payments/:paymentId/void` | `{ reason }` | 200 `{ payment, invoice, journal }` / 409 `PAYMENT_VOIDED` | FR-021 |

`PaymentView` = `{ id, receivedOn, amount, feeAmount, depositAccountId, depositSubAccountId, journalId, voidedAt, voidReason, voidJournalId }`。

## 5. 定期仕訳（US3）

`RecurringInput` = `{ name, memo?, dayOfMonth (1〜31。31 = 末日), startMonth, endMonth?, lines: LineDraft[] }`（001 の仕訳の行と同じ形。`taxCategory` は省略可）。

| § | メソッド | パス | 入力 | 出力 | 要件 |
|---|---|---|---|---|---|
| 5.1 | GET | `/recurring-journals` | — | 200 `{ recurring: RecurringView[] }`（`RecurringView` = 定義 ＋ `{ status, version, nextDate, postedCount }`） | FR-023 |
| 5.2 | POST | `/recurring-journals` | `RecurringInput & { confirm? }` | 201 `{ recurring, posted: JournalRef[] }`（保存の直後にその事業体の判定を走らせた結果。R18）/ 409 `RECURRING_CONFIRM_REQUIRED` / 422 `UNBALANCED` など 001 の検証 | FR-023, FR-029 |
| 5.3 | GET | `/recurring-journals/:id` | — | 200 `{ recurring, runs: { targetMonth, status, journalId, skipReason, createdAt }[], blocked: BlockedRun[] }` | FR-028 |
| 5.4 | PUT | `/recurring-journals/:id` | `RecurringInput & { version, confirm? }` | 200 `{ recurring, posted }` / 409 `VERSION_CONFLICT`・`RECURRING_CONFIRM_REQUIRED` | FR-023, FR-026 |
| 5.5 | POST | `/recurring-journals/:id/pause` | `{ version }` | 200 `{ recurring }` | FR-023 |
| 5.6 | POST | `/recurring-journals/:id/resume` | `{ version, fromMonth?, confirm? }`（`fromMonth` の既定は今日の月。R20） | 200 `{ recurring, posted }` / 409 `RECURRING_CONFIRM_REQUIRED` | FR-023, FR-029 |
| 5.7 | POST | `/recurring-journals/:id/runs/:month/skip` | `{ reason }` | 200 `{ run }`（`blocked` の回を「登録しない」にする） | FR-027 |
| 5.8 | GET | `/recurring-journals/status` | — | 200 `{ unacknowledged: { runId, recurringId, name, targetMonth, journal: JournalRef }[], blocked: BlockedRun[] }`（`BlockedRun` = `{ recurringId, name, targetMonth, date, reason: "PERIOD_CLOSED" \| "OUT_OF_PERIOD" \| "ACCOUNT_INACTIVE" \| "ACCOUNT_NOT_FOUND" \| "PARTNER_INACTIVE" }`） | FR-027, FR-028 |
| 5.9 | POST | `/recurring-journals/acknowledge` | `{ runIds }` | 204 | FR-028 |

- `/recurring-journals/status`・`/acknowledge` は `/:id` より先に登録する（Hono のルートの順）
- 判定（`postDueRecurring`）は HTTP の手続きを持たない。起動時・1時間ごと（server のスケジューラー）と 5.2・5.4・5.6 の直後に走る（research R18）

## 6. 仕訳との相互参照（FR-009, FR-028）

| § | メソッド | パス | 出力 | 要件 |
|---|---|---|---|---|
| 6.1 | GET | `/journals/:journalId/origin` | 200 `{ origin: null \| { kind: "invoice", invoiceId, invoiceNo } \| { kind: "payment", invoiceId, invoiceNo, paymentId } \| { kind: "recurring", recurringId, name, targetMonth } }` / 404 `JOURNAL_NOT_FOUND` | FR-009, FR-028 |

001 の変更: `PUT /journals/:journalId`・`POST /journals/:journalId/void` は `source` が `invoice`・`payment` の仕訳に 409 `JOURNAL_LINKED`。`POST /journals` の `correctsJournalId` がそれらの仕訳なら同じく 409。`Journal.source` の値に `invoice`・`payment`・`recurring` が加わる（`GET /journals` の応答の型が広がる）。
