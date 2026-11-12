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
| `computeBalances({opening, lines, periodStart, from?, to})` | 期首残高、会計期間の開始日からの行 | 科目・補助科目ごとの期首・借方・貸方・期末（借方を正） | 取消済み・範囲外の行は含まない。`[periodStart, from)` の行は期首に繰り込む |
| `buildTrialBalance({accounts, opening, lines, periodStart, from, to})` | | 試算表（残高は科目の通常の側を正） | INV-4, INV-6 |
| `buildJournalBook({lines, from, to})` | | 仕訳帳（日付・仕訳番号・行番号の順） | FR-026 |
| `buildGeneralLedger({accounts, opening, lines, periodStart, from, to, accountId, subAccount})` | | 元帳（前期繰越・残高の推移。相手科目が複数なら「諸口」） | FR-027 |
| `buildProfitAndLoss({accounts, lines, from, to})` / `compareProfitAndLoss(cur, prev, accounts)` | | PL（区分の計・売上総利益・差引金額。比較は前年・増減） | FR-029, FR-030 |
| `buildBalanceSheet({accounts, opening, lines, periodStart, asOf})` / `compareBalanceSheet(cur, prev, accounts)` | | BS（純資産の区分の計は当期利益を含まない） | INV-5 |
| `detectWarnings(balances, accounts, {fiscalYear, openingRegistered}?)` | | 警告の一覧（期首残高の未登録 → マイナス残高の順） | FR-033 |
| `toCsv(report)` | | CSV 文字列（BOM 付き UTF-8、CRLF、RFC 4180 の引用） | FR-032 |

帳票のユースケース（`usecases/reports.ts`）は `getJournalBook` / `getTrialBalance` / `getGeneralLedger` / `getProfitAndLoss` / `getBalanceSheet`。依存は `{masters: MasterRepository, reports: ReportRepository}`。`from`（BS は `asOf`）を含む会計期間がなければ `OUT_OF_PERIOD`、`to` がその会計期間の外なら `VALIDATION`（仕訳帳は会計期間をまたいでよい）。前年比較は日付を 1 年戻し（2/29 は 2/28）、前年の会計期間がなければ前年の値を 0 とする。警告は `to`（BS は `asOf`）を含む会計期間で判定する。

## リポジトリのポート（packages/db が実装）

```ts
interface JournalRepository extends AuditLog {     // 仕訳の登録（US2）。appendAudit は AuditLog
  transaction<T>(fn: (tx: JournalRepository) => T): T
  nextJournalNo(): number
  lastJournal(): Journal | undefined
  insertJournal(j: NewJournal): Journal
  getJournal(id: string): Journal | undefined
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
  // 有効な仕訳の行（両端を含む）。日付・仕訳番号・行番号の順。科目・補助科目・取引先の名前を結合した 1 クエリ（R12）
  linesInRange(from: string, to: string): PostedLine[]
  // 会計年度の期首残高。年度がなければ空
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

## ユースケース（US5）

| 関数 | 結果 | 要件 |
|---|---|---|
| `closePeriod({ repo, ids, clock }, fiscalYear)` | `Result<FiscalPeriod>`。`closedAt` に締めた日時。audit_log に `close`（before・after に会計期間） | FR-024, FR-025 |
| `reopenPeriod({ repo, ids, clock }, fiscalYear, { reason })` | `Result<FiscalPeriod>`。`closedAt` は null。audit_log に `reopen` と理由 | FR-024, FR-025 |
| `getFiscalPeriodHistory({ repo })` | `FiscalPeriodHistoryEntry[]`（全年度, 記録の順） | FR-025 |

締め済みの年度の締め・締めていない年度の解除は、状態も audit_log も変えずに現在の会計期間を返す。
`MasterRepository.fiscalPeriodHistory()` は `target_type = fiscal_period` の audit_log を記録の順で返す。
締め済みの年度への登録・訂正・取消・期首残高の置換は、それぞれのユースケースが `PERIOD_CLOSED` で拒否する（INV-7）。

ユースケース（`packages/domain/src/usecases`）は、このポートと純関数を組み合わせて
「検証 → トランザクション内で書込 + 監査ログ追記」を行う。
