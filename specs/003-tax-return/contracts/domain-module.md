# Contract: ドメイン層のモジュール（003 の追加分）

001 の [domain-module.md](../../001-ledger-core/contracts/domain-module.md)、002 の [domain-module.md](../../002-freee-import/contracts/domain-module.md) に追加する。置き場所は `packages/domain/src/blue-return/`。すべて純関数で、I/O はしない。

## 定数・データ

| 名前 | 場所 | 内容 |
|---|---|---|
| `BLUE_RETURN_FORMS` / `formForYear(year)` | `blue-return/form.ts` | 様式（R2）。年度から様式を選ぶ |
| `TAX_PARAMETERS` | `seed/tax-parameters.ts` | 税制の値の seed（R3）。マイグレーションの投入と同じ値 |

## 関数

| 関数 | 入力 | 出力 | 不変条件・要件 |
|---|---|---|---|
| `resolveTaxParameter(key, date, params)` | | `TaxParameter \| undefined` | R3 |
| `computeHomeUse(bookAmount, ratio)` | 帳簿の金額、万分率 | `{ business, home }` | INV-20, R5 |
| `proposeHomeUseAdjustment(input)` | `{ allocation, allocations（同じ年度の登録の全部）, accounts, period（endDate）, lines（年度の仕訳の行）, refs（決算整理の出所） }` | `Result<HomeUseAssessment>` = `{ allocationId, bookAmount, ratio, business, home, registered, difference, proposal: AdjustmentProposal \| null, reason }`。`difference = home − registered`。0 なら `proposal` は null で `reason` は `BOOK_AMOUNT_NOT_POSITIVE` / `FULL_BUSINESS` / `UP_TO_DATE`。案の仕訳の両方の行の税区分は `OUT_OF_SCOPE`（内部の振替で、課税期間でも仕入にしない）。対象が費用の科目でなければ `HOME_USE_ACCOUNT_INVALID`、事業主貸がなければ `ACCOUNT_NOT_FOUND` | FR-014, FR-016, INV-23 |
| `validateHomeUseAllocation(draft, { accounts, subAccounts, previous })` | `draft`: `HomeUseAllocationDraft`（`fiscalYear, accountId, subAccountId, businessRatio, basis, changeReason`）、`previous`: 前の年度の同じ科目（補助科目）の登録（なければ undefined） | `Result<HomeUseAllocationDraft>`（根拠・理由は trim、空の理由は null。区分が費用の科目に限る `HOME_USE_ACCOUNT_INVALID`、補助科目の不一致と割合の範囲は `VALIDATION`、根拠の必須 `HOME_USE_BASIS_REQUIRED`、割合を変えたときの理由の必須 `HOME_USE_CHANGE_REASON_REQUIRED`）。ID と日時は `saveHomeUseAllocation` が付ける | FR-012, FR-013 |
| `validateFixedAsset(draft, sameYearAssets, params)` | 資産の案、同じ年の特例の資産、税制の値 | `Result<FixedAsset>`（`ASSET_ACCOUNT_INVALID`、`SMALL_ASSET_OVER_THRESHOLD`、`SMALL_ASSET_ANNUAL_LIMIT_EXCEEDED`、`SMALL_ASSET_NOT_APPLICABLE`（適用期間外）、`DEPRECIATION_METHOD_UNSUPPORTED`） | FR-019〜020, INV-21 |
| `depreciate(asset, fiscalYear)` | 方法は `small_asset_28_2` だけ。方法の表は作らない（R7） | `{ cost, base, ordinary, total, businessRatio, deductible, closingBookValue }`（3ページのイ〜ヌ） | FR-021, INV-21 |
| `proposeDepreciationAdjustment(asset, fiscalYear, accounts)` | | `AdjustmentProposal \| null`（`linkedJournalId` があれば null） | FR-021〜022, INV-23 |
| `blueDeductionCap(answers, date, params)` | 要件の回答 | `{ cap, tier: "max" \| "standard" \| "basic", unmet: string[] } \| undefined`（回答なしは undefined） | FR-010, R9 |
| `blueDeduction(cap, incomeBefore)` | | 控除額 | FR-009, INV-22 |
| `summarizeMonthlySales(lines, accounts, range)` | `range = { startDate, endDate }`（`period`）。取消済みと期間外の行は除く（`buildProfitAndLoss` と同じ）。売上の区分の科目は売上高、雑収入（コード `4020`）と「その他」の区分の科目は雑収入。月ごとに貸方−借方 | `{ months: { month: 1..12, sales, otherIncome, total }[12], total: { sales, otherIncome, total } }`（`page2.monthly`） | FR-024, INV-24 |
| `summarizeSalesPartners(lines, accounts, range, rows)` | `rows` は様式の個別の行数（`salesPartnerRows`）。取引先名は行の `partnerName`（取引先の一覧は要らない）。売上高の行を `partnerId` ごとに貸方−借方で集計 | `{ rows: { partnerId, name, amount }[], others, total, withoutPartner: { count, amount } \| null, duplicateNames: { name, partnerIds[] }[] }`。個別の行は金額の降順（同額は名前、ID の順）で `rows` 行まで、合計が 0 以下の取引先は個別に出さない。`others` = 残りの取引先 + 取引先なしの売上高 + 雑収入。`total` = 個別の行 + `others`（`page3.salesPartners`。`duplicateNames` は出力に含めず警告にする） | FR-025〜026, INV-24 |
| `salesWarnings({ line1, monthly, partners })` | 欄1 の金額、月別、売上先 | `BlueReturnWarning[]`: `SALES_TOTAL_MISMATCH`（月別・売上先それぞれ。`details = { target: "monthly" \| "partners", line1, total, difference }`）、`SALES_WITHOUT_PARTNER`（`{ count, amount }`）、`DUPLICATE_PARTNER_NAME`（名前ごとに `{ name, partnerIds }`） | FR-026 |
| `checkOpeningCarryForward(priorClosing: CarryForwardBalance[], opening: OpeningInput[], accounts: Account[])` | 前の年度の期末の残高（借方を正）、今の年度の期首残高、科目 | `Result<OpeningMismatch[]>`。`OpeningMismatch = { accountId, subAccountId \| null, expected, actual, diff }`（金額は科目の通常の側を正とする符号つき。`diff = actual − expected`、0 の行は返さない。並びは科目の順 → 補助科目なしが先）。002 の `carryForward` を使い、失敗（元入金の科目がない）はそのエラーを返す | FR-029, R8 |
| `buildBlueReturn(input: BuildBlueReturnInput)` | `{ period, accounts, lines, deductionAnswers \| null, taxParameters, allocations?, adjustmentRefs?, rentDetails?, fixedAssets?, opening?, priorPeriod?: PriorPeriod \| null, closingNotes? }`。`PriorPeriod = { fiscalYear, status, closing: CarryForwardBalance[] }`（前の年度の帳簿があるときだけ。なければ null で `no_prior_year`）。年度の状態は `period.status`。取引先名は `lines` の `partnerName`。特殊事情のメモは `closingNotes` の `special_circumstances` | `BlueReturn`（data-model §2）。4ページは `buildPage4`（`page4` と警告 `OPENING_MISMATCH`、`PRIOR_PERIOD_OPEN`、`OPENING_OWNER_ACCOUNTS`、`DEFERRED_ASSET_NOT_AMORTIZED`、`NEGATIVE_BALANCE`、4ページの `OPTIONAL_LINES_OVERFLOW`）が作る | FR-001〜032 の表示、INV-18〜24 |
| `blueReturnToCsv(blueReturn, { blankUnused })` | `blankUnused` なら `kind = unused` の欄を空にする（R14） | CSV の文字列（`ページ,欄番号,欄名,金額`） | FR-003, R14 |

`buildBlueReturn` は 001 の `buildProfitAndLoss`・`buildBalanceSheet`・`detectWarnings` を呼び、結果を様式に並べ替える。PL の費用合計・利益との一致（INV-18）を自分で確かめ、合わなければ `PL_MISMATCH` を出す。

## 科目の欄番号の変更（001 の変更）

| 関数 | 変更 |
|---|---|
| `setAccountReportLine(deps, accountId, reportLine)`（新規、`usecases/masters.ts`。`renameAccount`・`setAccountActive` と同じ形） | server の `PATCH /accounts/:accountId`（`apps/server/src/routes/masters.ts:38`）が `patch.reportLine !== undefined` のときに呼ぶ。費用の科目で、様式の費用の欄（8〜31）の番号か `null` のときだけ許す（それ以外は `REPORT_LINE_INVALID`）。変更は `ClosingStore.appendClosingAudit`（`account_report_line`、`update`）に残す（R12a） |

## 免税の期間の警告（002 の変更）

| 関数 | 変更 |
|---|---|
| `planImport(input)`（`import/freee/plan.ts`） | `warningsOf` で仕訳の日付の消費税の設定を `resolveTaxSetting` で引き、`exempt` なら `TAX_CATEGORY_SUSPICIOUS` を1件ずつ出さず、`TAX_CATEGORY_SUSPICIOUS_EXEMPT`（`details: { count, freeeJournalIds }`）を1件にまとめる（R11, FR-037）。入力の型は変えない（消費税の設定はすでに入力にある） |

## ユースケース（`usecases/blue-return.ts`）

| 関数 | 依存 | 説明 |
|---|---|---|
| `getBlueReturn(deps, { fiscalYear })` | `ReportDeps`、`ClosingStore` | 個人の事業体でなければ `ENTITY_KIND_UNSUPPORTED`。年度の仕訳・期首残高・前の年度の期末を読み、`buildBlueReturn` |
| `saveHomeUseAllocation(deps, draft)` | `ClosingStore`、`IdGenerator`、`Clock` | `validateHomeUseAllocation` → 保存 → `closing_audit_log` |
| `getAdjustmentProposals(deps, { fiscalYear })` | `ReportDeps`、`ClosingStore` | 按分と資産の案の一覧（差があるものだけ） |
| `commitAdjustment(deps, { fiscalYear, kind, sourceId, expected: { amount } })` | `{ uow: ClosingUnitOfWork, reports: ReportRepository（トランザクションと同じ接続）, ids, clock }` | 1トランザクションで案を作り直し、`expected.amount`（借方合計）と比べてから 001 の `createJournal` → `adjustment_journal_refs`。`Result<{ journal, ref, warnings }>`。締め済みは 001 の `PERIOD_CLOSED`、案がなければ `ADJUSTMENT_NOT_NEEDED`、金額が違えば `ADJUSTMENT_CHANGED`（`details.proposal`）。減価償却（`depreciation`）は US3 まで VALIDATION |
| `listHomeUseAllocations(deps, { fiscalYear })` | `MasterRepository`、`ClosingStore` | `Result<{ allocations, previousYear }>`。年度の登録と、前の年度の登録（`GET .../home-use`） |
| `getRentDetails(deps, { fiscalYear })` | `MasterRepository`、`ClosingStore` | `Result<RentDetail[]>`。並び順は保存したとおり（`GET .../rent-details`） |
| `saveFixedAsset(deps, draft)` / `disposeFixedAsset(deps, { id, disposedOn, reason })` | `ClosingStore`、`IdGenerator`、`Clock` | `validateFixedAsset` → 保存 → 履歴 |
| `saveClosingNote(deps: ClosingSettingsDeps, { fiscalYear, kind: "special_circumstances" \| "opening_difference", body })` | `{ masters, closing: ClosingStore, ids, clock }` | `Result<ClosingNote>`（`{ fiscalYear, kind, body, updatedAt }`）。個人の事業体でなければ `ENTITY_KIND_UNSUPPORTED`、会計期間がなければ `VALIDATION`。`body` は前後の空白を除き、5000 文字を超えると `VALIDATION`（`details.field: "body"`）。空にもできる（`openingDifferenceNote` は null に戻る）。締め済みの年度でも保存できる。保存と履歴（`closing_note`、`create` / `update`）は呼び出し側の1トランザクション（`PUT .../notes/:kind`） |
| `saveRentDetails`、`saveDeductionAnswers`、`saveTaxReturnMemo`、`saveFiledDocument`（と削除） | `ClosingStore`、`Clock` | 検証 → 保存 → 履歴（履歴は按分・資産・内訳・回答・メモだけ） |

## ポート（packages/db が実装）

```ts
interface ClosingStore {
  listTaxParameters(): TaxParameter[]
  listHomeUseAllocations(fiscalYear: number): HomeUseAllocation[]
  upsertHomeUseAllocation(row: HomeUseAllocation): void
  listRentDetails(fiscalYear: number): RentDetail[]
  replaceRentDetails(fiscalYear: number, rows: RentDetail[]): void
  listFixedAssets(): FixedAsset[]
  upsertFixedAsset(row: FixedAsset): void
  listAdjustmentRefs(fiscalYear: number): AdjustmentRef[]
  insertAdjustmentRef(ref: AdjustmentRef): void
  getDeductionAnswers(fiscalYear: number): DeductionAnswers | undefined
  upsertDeductionAnswers(row: DeductionAnswers): void
  listClosingNotes(fiscalYear: number): ClosingNote[]
  upsertClosingNote(row: ClosingNote): void
  listTaxReturnMemos(fiscalYear: number): TaxReturnMemo[]
  upsertTaxReturnMemo(row: TaxReturnMemo): void
  deleteTaxReturnMemo(id: string): void
  listFiledDocuments(fiscalYear: number): FiledDocument[]
  upsertFiledDocument(row: FiledDocument): void
  deleteFiledDocument(id: string): void
  appendClosingAudit(entry: ClosingAuditEntry): void
}

interface ClosingUnitOfWork {
  transaction<T>(fn: (tx: { journals: JournalRepository; masters: MasterRepository; closing: ClosingStore }) => T): T
}
```
