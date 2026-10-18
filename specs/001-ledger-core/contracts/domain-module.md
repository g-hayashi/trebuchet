# Contract: ドメイン層のモジュール（packages/domain）

Constitution VII により、ドメイン層は Hono・React・DB に依存しない純粋な TypeScript とする。
API とテストはこのインターフェースを通してのみ会計ロジックを使う。

## 型

```ts
type Yen = number & { readonly __brand: "Yen" }   // 正の安全な整数, < 1e12
type Side = "debit" | "credit"
type JournalDraft = { date: string; memo?: string; correctsJournalId?: string; lines: LineDraft[] }
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E }
```

## 関数（すべて純関数。I/O はしない）

| 関数 | 入力 | 出力 | 不変条件 |
|---|---|---|---|
| `validateJournal(draft, ctx)` | 下書き、科目・会計期間・消費税設定の参照 | `Result<ValidJournal, JournalError[]>` | INV-1〜3, INV-7 |
| `computeInclusiveTax(amount, rate)` | 税込額、税率 | 内税額（切り捨て） | INV-10 |
| `resolveTaxRate(categoryCode, date, rates)` | 税区分、日付、税率のデータ | 税率（課税の区分以外は `undefined`） | INV-10, Constitution VI |
| `defaultTaxCategory(date, side, account, settings)` | | 税区分コード | FR-017 |
| `resolveTaxSetting(date, settings)` | | 適用される設定 | FR-009 |
| `validateTaxSettings(settings, firstPeriodStart)` | | `Result` | FR-009 |
| `validateOpeningBalances(rows)` | | `Result` | FR-011 |
| `buildTrialBalance(opening, lines, period)` | | 試算表 | INV-4, INV-6 |
| `buildGeneralLedger(opening, lines, account, range)` | | 元帳 | |
| `buildProfitAndLoss(lines, accounts, range)` | | PL | |
| `buildBalanceSheet(opening, lines, accounts, asOf)` | | BS | INV-5 |
| `detectWarnings(balances, accounts)` | | 警告の一覧 | FR-033 |
| `toCsv(report)` | | CSV 文字列 | FR-032 |

## リポジトリのポート（packages/db が実装）

```ts
interface LedgerRepository {
  transaction<T>(fn: (tx: LedgerRepository) => T): T
  nextJournalNo(): number
  insertJournal(j: ValidJournal): Journal
  replaceJournal(id: string, j: ValidJournal, expectedVersion: number): Journal
  voidJournal(id: string, expectedVersion: number): Journal
  appendAudit(entry: AuditEntry): void
  findJournals(query: JournalQuery): Page<Journal>
  linesInRange(from: string, to: string): PostedLine[]   // 有効な仕訳のみ
  openingBalances(fiscalYear: number): OpeningBalance[]
  // マスタの取得・保存は省略
}
```

ユースケース（`packages/domain/src/usecases`）は、このポートと純関数を組み合わせて
「検証 → トランザクション内で書込 + 監査ログ追記」を行う。
