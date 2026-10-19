# Contract: ドメイン層のモジュール（003 の追加分）

001 の [domain-module.md](../../001-ledger-core/contracts/domain-module.md)、002 の [domain-module.md](../../002-freee-import/contracts/domain-module.md) に追加する。置き場所は `packages/domain/src/blue-return/`。すべて純関数で、I/O はしない。

## 定数・データ

| 名前 | 場所 | 内容 |
|---|---|---|
| `BLUE_RETURN_FORMS` / `formForYear(year)` | `blue-return/form.ts` | 様式（R2）。年度から様式を選ぶ |
| `TAX_PARAMETERS` | `seed/tax-parameters.ts` | 税制の値の seed（R3）。マイグレーションの投入と同じ値 |
| `DEPRECIATION_METHODS` | `blue-return/depreciation.ts` | 方法 → 計算関数の表。`small_asset_28_2` だけ（R7） |

## 関数

| 関数 | 入力 | 出力 | 不変条件・要件 |
|---|---|---|---|
| `resolveTaxParameter(key, date, params)` | | `TaxParameter \| undefined` | R3 |
| `computeHomeUse(bookAmount, ratio)` | 帳簿の金額、万分率 | `{ business, home }` | INV-20, R5 |
| `proposeHomeUseAdjustment(input)` | 按分の登録、科目、年度の仕訳の行、登録済みの振替（refs） | `Result<AdjustmentProposal \| null>`（帳簿の金額 ≤ 0 なら null と理由） | FR-014, FR-016, INV-23 |
| `validateHomeUseAllocation(draft, previous)` | 登録の案、前の年度の同じ科目の登録 | `Result<HomeUseAllocation>`（根拠の必須、割合の範囲、割合を変えたときの理由の必須） | FR-012, FR-013 |
| `validateFixedAsset(draft, sameYearAssets, params)` | 資産の案、同じ年の特例の資産、税制の値 | `Result<FixedAsset>`（`SMALL_ASSET_OVER_THRESHOLD`、`SMALL_ASSET_ANNUAL_LIMIT_EXCEEDED`、`SMALL_ASSET_NOT_APPLICABLE`（適用期間外）、`DEPRECIATION_METHOD_UNSUPPORTED`） | FR-019〜020, INV-21 |
| `depreciate(asset, fiscalYear)` | | `{ cost, base, ordinary, total, businessRatio, deductible, closingBookValue }`（3ページのイ〜ヌ） | FR-021, INV-21 |
| `proposeDepreciationAdjustment(asset, fiscalYear, accounts)` | | `AdjustmentProposal \| null`（`linkedJournalId` があれば null） | FR-021〜022, INV-23 |
| `blueDeductionCap(answers, date, params)` | 要件の回答 | `{ cap, tier: "max" \| "standard" \| "basic", unmet: string[] } \| undefined`（回答なしは undefined） | FR-010, R9 |
| `blueDeduction(cap, incomeBefore)` | | 控除額 | FR-009, INV-22 |
| `summarizeMonthlySales(lines, accounts, fiscalYear)` | | 月別の売上・雑収入・計 | FR-024, INV-24 |
| `summarizeSalesPartners(lines, accounts, partners, rows)` | | 個別の行・上記以外の計・取引先なしの件数と金額 | FR-025〜026, INV-24 |
| `checkOpeningCarryForward(priorClosing, opening, accounts)` | 前の年度の期末の残高、今の年度の期首残高 | `{ accountId, expected, actual, diff }[]`（002 の `carryForward` を使う） | FR-029, R8 |
| `buildBlueReturn(input)` | 様式、科目、取引先、期首残高、年度の仕訳の行、前の年度の期末の残高（任意）、按分の登録、決算整理の refs、資産、地代家賃の内訳、控除の回答、税制の値、メモ、年度の状態 | `BlueReturn`（data-model §2） | FR-001〜032 の表示、INV-18〜24 |
| `blueReturnToCsv(blueReturn)` | | CSV の文字列（`ページ,欄番号,欄名,金額`） | FR-003, R14 |

`buildBlueReturn` は 001 の `buildProfitAndLoss`・`buildBalanceSheet`・`detectWarnings` を呼び、結果を様式に並べ替える。PL の費用合計・利益との一致（INV-18）を自分で確かめ、合わなければ `PL_MISMATCH` を出す。

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
| `commitAdjustment(deps, { fiscalYear, kind, sourceId, expected })` | `ClosingUnitOfWork`、`IdGenerator`、`Clock` | 1トランザクションで案を作り直し、`expected`（借方合計）と比べてから 001 の `createJournal` → `adjustment_journal_refs`。締め済みは 001 の `PERIOD_CLOSED` |
| `saveFixedAsset(deps, draft)` / `disposeFixedAsset(deps, { id, disposedOn, reason })` | `ClosingStore`、`IdGenerator`、`Clock` | `validateFixedAsset` → 保存 → 履歴 |
| `saveRentDetails`、`saveDeductionAnswers`、`saveClosingNote`、`saveTaxReturnMemo`、`saveFiledDocument`（と削除） | `ClosingStore`、`Clock` | 検証 → 保存 → 履歴（履歴は按分・資産・内訳・回答・メモだけ） |

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
