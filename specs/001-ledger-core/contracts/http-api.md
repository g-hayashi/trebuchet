# Contract: HTTP API（001-ledger-core）

- ベースパス: `/api`
- 形式: JSON（UTF-8）。CSV 出力のみ `text/csv; charset=utf-8`（BOM 付き, Excel 互換）
- テナントの指定: パスに `/entities/:entityId` を含める。サーバーは `entityId` から該当の DB ファイルだけを開く
- 入出力のスキーマは `packages/schema` の Zod 定義が正本。このファイルはその要約
- クライアントは Hono RPC（`hc<AppType>`）で型を共有する（[research.md](../research.md) R3）
- 認証は 003 で追加する。001 ではローカルホストからのアクセスのみ受け付ける

## エラー形式

```json
{ "error": { "code": "UNBALANCED", "message": "借方と貸方が一致しません", "details": { "debit": 500000, "credit": 495000, "diff": 5000 } } }
```

| HTTP | code | 発生条件 | 要件 |
|---|---|---|---|
| 400 | `VALIDATION` | スキーマ違反（金額が整数でない、必須項目なし） | FR-013, FR-014 |
| 422 | `UNBALANCED` | 借方合計 ≠ 貸方合計 | FR-015 |
| 422 | `ACCOUNT_INACTIVE` / `ACCOUNT_NOT_FOUND` | 使用停止・存在しない科目 | FR-015 |
| 422 | `OUT_OF_PERIOD` | 日付に対応する会計期間がない。最後の会計期間より後の日付（または会計期間がない）ときは `details.suggest = "create_fiscal_period"` | FR-015 |
| 409 | `PERIOD_CLOSED` | 締め済み年度への登録・訂正・取消。`details.suggest = "correcting_entry"` | FR-015, FR-019a, FR-024 |
| 422 | `REASON_REQUIRED` | 理由のない訂正・取消・締めの解除。空欄・空白のみ・500 文字を超える理由。判定はドメインで行う（Zod では `reason` を文字列であることだけ検証する）。`details.field = "reason"` | FR-019, FR-024 |
| 422 | `TAX_METHOD_UNSUPPORTED` | 税抜経理の期間の日付の仕訳（001 では未対応） | FR-017 |
| 409 | `VERSION_CONFLICT` | 楽観ロックの不一致。仕訳では `details: { journalId, currentVersion }` | — |
| 409 | `JOURNAL_VOIDED` | 取消済みの仕訳の訂正・取消。`details.journalId` | FR-021 |
| 409 | `ACCOUNT_IN_USE` | 使用中の科目の削除 | FR-005 |
| 422 | `TAX_SETTING_GAP` | 消費税の設定期間の空白・重複 | FR-009 |
| 404 | `ENTITY_NOT_FOUND` | 事業体がない | FR-002 |
| 404 | `JOURNAL_NOT_FOUND` | 仕訳がない。`details.journalId` | FR-019a |

仕訳の登録で複数の誤りがあるときは、最初の誤りを `code`・`message` とし、`details.errors` にすべての誤り（`{ code, message, details }` の配列）を入れる。行に結び付く誤りの `details` には `lineIndex`（0 始まり）と `field`（`accountId`・`amount` など）を入れる。Zod のスキーマ違反（400）は `details.issues` に Zod の issue（`path` 例: `["lines", 1, "amount"]`）を入れる。

成功時の警告（登録は成功）は `warnings: [{ code: "POSSIBLE_DUPLICATE", message, details: { journalId, journalNo } }]` で返す（FR-018）。直前に登録した有効な仕訳と、日付と行（貸借・科目・金額の組の集合）が同じときに出す。

## 事業体

| メソッド | パス | 説明 | 要件 |
|---|---|---|---|
| GET | `/entities` | 事業体の一覧 | FR-003 |
| POST | `/entities` | `{ name, kind, fiscalStartMonth, firstFiscalYear }` → 作成し、初期の勘定科目・会計期間・消費税の設定（免税・税込）を投入 | FR-001, FR-004 |
| PATCH | `/entities/:entityId` | 名称の変更 | FR-001 |

## マスタ

| メソッド | パス | 説明 | 要件 |
|---|---|---|---|
| GET / POST | `/entities/:id/accounts` | 科目の一覧・追加 | FR-004, FR-005 |
| PATCH | `/entities/:id/accounts/:accountId` | `{ name?, isActive? }` | FR-005 |
| DELETE | `/entities/:id/accounts/:accountId` | 未使用のときのみ | FR-005 |
| GET / POST | `/entities/:id/accounts/:accountId/sub-accounts` | 補助科目 | FR-006 |
| GET / POST / PATCH | `/entities/:id/partners[/:partnerId]` | 取引先 | FR-007 |
| GET / POST | `/entities/:id/tags` | メモタグ | FR-008 |
| GET | `/entities/:id/tax-categories` | 税区分の一覧 | FR-010 |
| GET / PUT | `/entities/:id/tax-settings` | 消費税の設定の一覧・一括置換 | FR-009 |

## 会計期間・期首残高

| メソッド | パス | 説明 | 要件 |
|---|---|---|---|
| GET / POST | `/entities/:id/fiscal-periods` | 一覧・翌年度の作成 | FR-012 |
| POST | `/entities/:id/fiscal-periods/:year/close` | 締め → 200 `{ fiscalPeriod }`（`status: "closed"`, `closedAt` に締めた日時） | FR-024 |
| POST | `/entities/:id/fiscal-periods/:year/reopen` | `{ reason }`（ReopenInput）締めの解除 → 200 `{ fiscalPeriod }`（`status: "open"`, `closedAt: null`） | FR-024, FR-025 |
| GET | `/entities/:id/fiscal-periods/history` | 締めと解除の履歴（全年度, 記録の順）→ 200 `{ history: PeriodHistoryEntry[] }` | FR-025 |
| GET / PUT | `/entities/:id/fiscal-periods/:year/opening-balances` | 期首残高の取得・一括置換（貸借一致が必須） | FR-011 |

締め・解除は audit_log に `target_type = fiscal_period`、`action = close | reopen`（解除は理由つき）、変更前後の会計期間を記録する。締め済みの年度を締める・締めていない年度を解除するときは、状態を変えず audit_log も残さずに 200 で現在の会計期間を返す。解除の判定順は `REASON_REQUIRED` → 年度の有無。ない年度・`:year` が4桁の数字でないときは 400 `VALIDATION`（`details.fiscalYear`）。

`PeriodHistoryEntry = { occurredAt, fiscalYear, action: "close" | "reopen", reason: string | null }`。年度ごとではなく事業体の全年度の履歴を1回で返す（会計期間の画面に一覧で表示するため）。

## 仕訳

### 入力スキーマ（JournalInput）

```ts
{
  date: "2026-10-31",            // YYYY-MM-DD
  memo?: string,
  correctsJournalId?: string,    // 締め済み年度の仕訳への訂正仕訳のとき
  lines: Array<{
    side: "debit" | "credit",
    accountId: string,
    subAccountId?: string,
    amount: number,              // 正の整数, < 1e12
    taxCategory?: TaxCategoryCode, // 省略時は日付の消費税の設定から既定値
    partnerId?: string,
    description?: string,
    tagIds?: string[]
  }>                             // 2行以上、借方・貸方とも1行以上
}
```

| メソッド | パス | 説明 | 要件 |
|---|---|---|---|
| POST | `/entities/:id/journals` | JournalInput → 201 `{ journal, warnings }`。`journal` は仕訳番号・行（`id`, `lineNo`, 決定した `taxCategory`, `taxAmount`）を含む | FR-013〜018 |
| GET | `/entities/:id/journals/:journalId` | 仕訳と行、訂正元・訂正仕訳への参照 | FR-019a |
| PUT | `/entities/:id/journals/:journalId` | `{ ...JournalInput, reason, version }`（JournalCorrection）訂正 → 200 `{ journal }`（`version` は +1） | FR-019, FR-020 |
| POST | `/entities/:id/journals/:journalId/void` | `{ reason, version }`（VoidInput）取消 → 200 `{ journal }`（`status: "voided"`, `version` は +1） | FR-019, FR-021 |
| GET | `/entities/:id/journals/:journalId/history` | 変更履歴 → `{ history: HistoryEntry[] }`（古い順） | FR-020, SC-005 |
| GET | `/entities/:id/journals?…` | 検索（下記）→ `{ journals, nextCursor }` | FR-023 |

詳細の応答: `{ journal, correctsJournal: JournalRef | null, correctingJournals: JournalRef[] }`。`JournalRef = { id, journalNo, date, status }`。`correctingJournals` はこの仕訳を訂正元とする訂正仕訳（仕訳番号の順）。

訂正・取消の判定順: 理由（`REASON_REQUIRED`）→ 仕訳の有無（`JOURNAL_NOT_FOUND`）→ 取消済み（`JOURNAL_VOIDED`）→ `version` の一致（`VERSION_CONFLICT`）→ 元の日付の年度が締め済み（`PERIOD_CLOSED`, `details: { fiscalYear, suggest: "correcting_entry" }`）→ 訂正後の内容の検証（POST と同じ。訂正後の日付が締め済み年度なら `PERIOD_CLOSED`）。訂正では、元の仕訳で使っている科目・補助科目・取引先は使用停止でも使える。

訂正仕訳（`correctsJournalId` を指定した POST、または訂正で `correctsJournalId` を変えたとき）は、訂正元の仕訳がない、または訂正元の年度が締め済みでないと `VALIDATION`（`details.field = "correctsJournalId"`）になる。取消済みの仕訳も訂正元にできる。

`HistoryEntry = { occurredAt, action: "create" | "correct" | "void", reason: string | null, before: Journal | null, after: Journal | null }`。`before`・`after` は仕訳の全内容（行・タグを含む）で、すべての過去の版を戻せる（SC-005）。登録では `before` が null。

検索パラメータ: `dateFrom`, `dateTo`, `amountMin`, `amountMax`, `partnerId`, `accountId`, `q`（摘要・メモの部分一致）, `tagId`, `includeVoided`（既定 false）, `cursor`, `limit`（1〜200, 既定 50）。条件はすべて AND で組み合わせる。

- 金額の範囲は、同じ行の金額が `amountMin` 以上かつ `amountMax` 以下になる行があれば一致とする。
- `partnerId`・`accountId`・`tagId` は、いずれかの行が一致すれば一致とする。
- `q` は前後の空白を除いた文字列で、仕訳のメモまたはいずれかの行の摘要の部分一致（大文字・小文字を区別する）。空なら条件なし。
- 並び順は日付の新しい順、同じ日付では仕訳番号の大きい順。
- `nextCursor` は続きがあるとき最後の仕訳の `"{date}_{journalNo}"`、なければ null。次のページは `cursor` に渡す。
- 画面（`/e/:entityId/journals`）は `cursor`・`limit` を除く検索パラメータを URL に入れる。

## 帳票

すべて `?format=csv` で CSV を返す（FR-032）。

| メソッド | パス | パラメータ | 要件 |
|---|---|---|---|
| GET | `/entities/:id/reports/journal-book` | `from`, `to` | FR-026 |
| GET | `/entities/:id/reports/general-ledger` | `from`, `to`, `accountId`, `subAccountId?` | FR-027 |
| GET | `/entities/:id/reports/trial-balance` | `from`, `to` | FR-028 |
| GET | `/entities/:id/reports/profit-and-loss` | `from`, `to`, `compare=previous-year?` | FR-029, FR-030 |
| GET | `/entities/:id/reports/balance-sheet` | `asOf`, `compare=previous-year?` | FR-029, FR-030 |

各帳票のレスポンスには `warnings`（例: `NEGATIVE_BALANCE` で科目と金額, `OPENING_BALANCE_MISSING`）を含める（FR-033, Edge Cases）。

- 期間: `from` を含む会計期間がなければ 422 `OUT_OF_PERIOD`。`to` がその会計期間の外、`from > to` は 400 `VALIDATION`（仕訳帳は会計期間をまたいでよい）。`accountId` の科目がなければ 422 `ACCOUNT_NOT_FOUND`
- CSV: `Content-Type: text/csv; charset=utf-8`、`Content-Disposition: attachment; filename="<kind>-<from>_<to>.csv"`（BS は `<asOf>`、元帳は `<科目コード>_<from>_<to>`）。BOM 付き UTF-8、改行は CRLF
- 金額は円の整数。試算表・元帳の残高は科目の通常の側を正とし、マイナスは負の数（画面では ▲）
- レスポンスの形（`packages/schema/src/reports.ts` が正。すべて `kind` と `warnings` を持つ）:

```ts
// 共通
type ReportAccount = { accountId; code; name; category; normalSide }
type Figure = { amount: number; previous?: number; change?: number }   // 比較時のみ previous・change

// journal-book
{ kind: "journal-book", from, to,
  entries: { journalId, journalNo, date, memo, lines: { lineNo, side, accountId, accountName,
    subAccountId, subAccountName, partnerId, partnerName, amount, taxCategory, taxAmount, description }[] }[],
  totals: { debit, credit }, warnings }
// general-ledger
{ kind: "general-ledger", from, to, account: ReportAccount, subAccount: { id, name } | null,
  broughtForward, entries: { journalId, journalNo, date, lineNo, counterpart /* 複数なら「諸口」 */,
    description, debit, credit, balance }[], totals: { debit, credit }, closing, warnings }
// trial-balance
{ kind: "trial-balance", from, to, rows: (ReportAccount & { opening, debit, credit, closing })[],
  totals: { debit, credit, closingDebit, closingCredit }, balanced, warnings }
// profit-and-loss（sections は PL_SALES → PL_COGS → PL_EXPENSE → PL_OTHER のうち行のある区分）
{ kind: "profit-and-loss", from, to, previous: { from, to } | null,
  sections: { section, rows: ({ accountId, code, name, reportLine } & Figure)[], total: Figure }[],
  grossProfit: Figure, netIncome: Figure, warnings }
// balance-sheet（sections は常に BS_ASSET・BS_LIABILITY・BS_EQUITY。純資産の total は当期利益を含まない）
{ kind: "balance-sheet", asOf, previousAsOf: string | null, sections: [...同上], netIncome: Figure,
  totalAssets: Figure, totalLiabilitiesAndEquity: Figure, balanced, warnings }
```
