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
interface JournalRepository extends AuditLog {     // 仕訳の登録（US2）。appendAudit は AuditLog
  transaction<T>(fn: (tx: JournalRepository) => T): T
  nextJournalNo(): number
  lastJournal(): Journal | undefined
  insertJournal(j: NewJournal): Journal
  getJournal(id: string): Journal | undefined
  recentJournals(limit: number): Journal[]
}

interface LedgerRepository extends JournalRepository {   // 訂正・取消・履歴・検索（US3）
  transaction<T>(fn: (tx: LedgerRepository) => T): T
  // 行・タグを全件置き換えて version +1。version 不一致は RepositoryConflictError
  replaceJournal(id: string, j: JournalReplacement, expectedVersion: number, updatedAt: string): Journal
  voidJournal(id: string, expectedVersion: number, updatedAt: string): Journal
  journalHistory(id: string): AuditEntry[]          // 記録の順
  correctingJournalsOf(id: string): Journal[]       // 仕訳番号の順
  findJournals(query: JournalQuery): Page<Journal>  // 日付の降順・同じ日付は仕訳番号の降順
}

interface ReportRepository {                       // 帳票（US4）
  linesInRange(from: string, to: string): PostedLine[]   // 有効な仕訳のみ
  openingBalances(fiscalYear: number): OpeningBalance[]
}
// マスタの取得・保存（MasterRepository）は省略
```

`Page<T> = { items: T[]; nextCursor: string | null }`。カーソルは最後の仕訳の `"{date}_{journalNo}"`。

## ユースケース（US3）

| 関数 | 結果 | 要件 |
|---|---|---|
| `correctJournal(deps, id, { ...JournalInput, reason, version })` | `Result<Journal>`。audit_log に `correct`（before・after に仕訳の全内容） | FR-019, FR-020 |
| `voidJournal(deps, id, { reason, version })` | `Result<Journal>`。audit_log に `void` | FR-019, FR-021 |
| `getJournalDetail({ ledger }, id)` | `Result<JournalDetail>`（訂正元・訂正仕訳への参照） | FR-019a |
| `getJournalHistory({ ledger }, id)` | `Result<JournalHistoryEntry[]>`（古い順） | FR-020, SC-005 |

判定順は REASON_REQUIRED → JOURNAL_NOT_FOUND → JOURNAL_VOIDED → VERSION_CONFLICT → PERIOD_CLOSED → `validateJournal`。
`createJournal` は `correctsJournalId` があるとき、訂正元が存在し締め済みの年度にあることを確かめる（FR-019a）。

ユースケース（`packages/domain/src/usecases`）は、このポートと純関数を組み合わせて
「検証 → トランザクション内で書込 + 監査ログ追記」を行う。
