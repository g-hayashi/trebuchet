# Data Model: 画面の作り直し（011）

帳簿の表（仕訳・科目・会計期間など）の形は変えない。変えるのは次の §1 だけ。§2 は保存しない値、§3 はブラウザの値、§4 は不変条件。

## 1. 事業体の DB（tenant）の変更

マイグレーション: `0016_ui_overhaul`（`drizzle-kit generate`。新しい表の `);` を `) STRICT;` に置き換える）、`0017_ui_overhaul_custom`（`--custom`。必要なら CHECK・トリガー）。番号は tasks の時点の最新に合わせる。

### 1.1 `journal_drafts`（新設。R6）

| 列 | 型 | 制約 |
|---|---|---|
| `id` | INTEGER | PRIMARY KEY、CHECK (`id = 1`) |
| `payload` | TEXT | NOT NULL。`JournalDraft` の JSON |
| `updated_at` | TEXT | NOT NULL。ISO 8601 |

- `JournalDraft`（schema）: `{ mode: "quick" | "detailed", date: string | null, memo: string, partnerId: string | null, tagIds: string[], lines: { side: "debit" | "credit", accountId: string | null, subAccountId: string | null, amount: number | null, taxCategory: string | null }[] }`。完成していない値を許す。金額は整数か null。行は 50 行まで、摘要は仕訳と同じ上限。
- 書くのは `PUT /journal-draft`（全体の置き換え）、消すのは `DELETE` と仕訳の登録の成功の後（web が呼ぶ）。仕訳の登録のトランザクションには入れない（下書きの削除の失敗で登録を止めない）。
- 監査の記録（`audit_log`）に書かない。バックアップには事業体の DB ごと含まれる。

### 1.2 `inference_rules.managed_by`（列を足す。R9）

| 列 | 型 | 制約 |
|---|---|---|
| `managed_by` | TEXT | NOT NULL DEFAULT `'auto'`、CHECK (`managed_by IN ('auto','user')`) |

- `user` になるのは、ルールの一覧から利用者が科目・税区分・状態（`paused` / `active`）を変えたとき（`PATCH /inference-rules/:ruleId`）。一度 `user` になったら戻らない（戻す操作は作らない）。
- 承認の学び（`learnRule`）と `seedRulesFromJournals` は `managed_by = 'user'` の行を変えない。承認の学びは `auto` の行を今の規則で作り・更新する。`seedRulesFromJournals` は今どおり、同じ内容のルールがない場合だけ作る（既存の行は `auto` でも更新しない）。
- `InferenceRule`（schema）に `managedBy: "auto" | "user"` を足す。
- 承認の入力（schema の承認の型）から `learn` を消す。

### 1.3 消す表（R10・R14）

- `eval_runs`（006 の評価の履歴）
- `tax_return_memos`、`filed_documents`（003 の申告の控え）

`DROP TABLE`。中の記録は移さない（開発中は利用者がいない）。バックアップ・復元・`tenant-store` のテストの表の一覧に名前があれば直す。

## 2. 保存しない値

### 2.1 `HomeSummary`（R3、contracts/http-api.md §1）

項目ごとに `Section<T> = { status: "ok"; value: T } | { status: "error"; code: string }`。

| 項目 | 値 | 求め方 |
|---|---|---|
| `tasks` | `{ unprocessedStatements, unlinkedReceipts, unpaidInvoices, overdueInvoices, blockedRecurring, blueReturnWarnings }`（整数） | 006 の状態の導出、010 の `link=none`（削除済みを除く）、005 の `unpaid|partial` と `overdue`、005 の `blocked` の判定、003 の `warnings`（今日を含む会計期間の年。なければ 0） |
| `figures` | `{ fiscalYear, from, to, sales, expenses, netIncome, cashAndDeposits, outstanding } \| null` | null は今日を含む会計期間がないとき。売上 = `PL_SALES` の合計、経費 = `PL_COGS` + `PL_EXPENSE` の合計、利益 = `netIncome`（期首〜期末）、現金と預金 = 今日時点の貸借対照表の `CASH_AND_DEPOSIT_CODES` の行の合計、未回収 = 未取消の請求書の残額の合計 |
| `recentJournals` | 最大 5 件の `{ id, number, date, memo, amount, createdAt }` | 取消を除き `created_at` の新しい順 |
| `lastStatementImportAt` | ISO 8601 か null | 取込の回の `created_at` の最大 |

### 2.2 `JournalSuggestion`（R5）

`{ debitAccountId, creditAccountId, taxCategory, partnerId: string | null, sourceJournalId, date }`。最大 3 件。2 行で取消でない仕訳から、摘要の正規化の一致か取引先の一致で、新しい順、`(借方, 貸方, 税区分, 取引先)` の組で重ねない。

### 2.3 一覧・帳票の応答に足す値

- 仕訳の一覧: `summary: { count: number; amount: number }`（R7）。
- 損益計算書・貸借対照表（`compare=previous-year` のとき）: `previousHasData: boolean`（R12）。
- 仕訳帳の問い合わせ: `sort: "date" | "created"`、`order: "asc" | "desc"`（R12）。
- `BackupStatus`: `folderSource: "configured" | "default"`（R16）。

## 3. ブラウザ（`localStorage`）の値（R4）

| 鍵 | 値 | 使う所 |
|---|---|---|
| 既存の `entityToRestore` の鍵 | 事業体の ID | ロゴ・事業体の名前・トップの移動 |
| `trebuchet.receiptCategory.<entityId>` | `paper_scan` \| `electronic` | 証憑の追加の区分の既定 |
| `trebuchet.depositAccount.<entityId>` | 科目の ID | 入金先の既定（使用停止なら使わない） |

## 4. 不変条件（INV-69〜72。`specs/INVARIANTS.md` に足す）

| ID | 内容 | 検証 |
|---|---|---|
| INV-69 | 下書きの作成・更新・削除は、仕訳・仕訳の行・監査の記録・試算表・帳票・ホームの要約を変えない | fast-check: 任意の仕訳の集合と任意の下書きの操作の列で、操作の前後の試算表・仕訳帳・`HomeSummary.figures` が一致する（domain の偽物と db の統合テスト） |
| INV-70 | `isSystem` の科目は、名前の変更と削除が `ACCOUNT_SYSTEM_PROTECTED` で拒まれ、拒まれた後の科目の表は変わらない。使用停止・再開はできる。`isSystem` でない科目の規則は変わらない | fast-check: 任意の科目と任意の操作の列 |
| INV-71 | `managed_by = 'user'` のルールは、任意の承認の列と `seedRulesFromJournals` の後も科目・税区分・状態が変わらない | fast-check: 任意のルールの集合と承認の列 |
| INV-72 | `HomeSummary.figures` の売上・経費・利益は、同じ会計期間の損益計算書の値と、現金と預金は今日時点の貸借対照表の該当の行の合計と一致する | fast-check: 任意の貸借一致の仕訳の集合（`ledger-setup.ts`） |
