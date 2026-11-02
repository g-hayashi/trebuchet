# Contract: ドメイン層のモジュール（009 の追加・変更分）

003 の [domain-module.md](../../003-tax-return/contracts/domain-module.md) に追加・変更する。置き場所は `packages/domain/src/blue-return/`。関数はすべて純関数で、I/O はしない。式は [data-model.md](../data-model.md) §2.2、根拠は [research.md](../research.md)。

## 1. 定数・データ

| 名前 | 場所 | 内容 |
|---|---|---|
| `STRAIGHT_LINE_RATES` | `seed/depreciation-rates.ts`（新規） | 定額法の償却率 49 行（R2）。マイグレーションの投入と同じ値 |
| `TAX_PARAMETERS` | `seed/tax-parameters.ts` | 4 行を足す（R13） |
| `INDIVIDUAL_ACCOUNTS` | `seed/accounts.individual.ts` | `5300` 固定資産除却損を足す（R9） |
| `DISPOSAL_LOSS_ACCOUNT_CODE = "5300"` | `blue-return/depreciation.ts` | 除却損の科目コード（R9） |
| `DEFERRED_ASSET_CODES` | `blue-return/balance-sheet.ts` | 変えない（`["1080"]`） |

## 2. 関数

| 関数 | 場所 | 入力 | 出力 | 要件・不変条件 |
|---|---|---|---|---|
| `resolveStraightLineRate(usefulLifeYears, acquiredOn, rates)` | `tax-parameters.ts` | | `StraightLineRate \| undefined`（`resolveTaxParameter` と同じ選び方） | R2 |
| `serviceMonths(asset, fiscalYear)` | `straight-line.ts`（新規） | | 1〜12、その年度に使っていなければ 0 | FR-006, R3 |
| `straightLineYear(asset, fiscalYear, rate)` | `straight-line.ts` | `rate` は解決済みの千分率 | `{ months, openingBookValue, depreciation, disposalAmount, closingBookValue }`（`disposalAmount` は除却の年度の償却の後の残高。廃棄・売却の分岐は `proposeDepreciationAdjustment`）。`startYear` から積み上げる | FR-005〜007, FR-009, INV-55 |
| `lumpSumYear(asset, fiscalYear, years)` | `lump-sum.ts`（新規） | `years` は `LUMP_SUM_YEARS` | `{ openingBookValue, depreciation, closingBookValue }` | FR-010〜011, INV-56 |
| `depreciate(asset, fiscalYear, params)` | `depreciation.ts`（変更） | `params = { rates, taxParameters }`（003 は引数 2 つ） | `Result<Depreciation>`（data-model §2.1）。率・税制の値がなければ `TAX_PARAMETER_MISSING`（`details.key`・`date`）。方法で `straightLineYear` / `lumpSumYear` / 003 の少額の計算に分ける | FR-005〜011, R3, R4 |
| `isDepreciationRow(asset, fiscalYear, params)` | `depreciation.ts`（変更） | | `boolean`（R11 の載せる行の規則） | FR-018, R11 |
| `validateFixedAsset(draft, sameYearAssets, params)` | `depreciation.ts`（変更） | `params` に `rates` を足す。`draft` に `inServiceOn`・`priorAccumulated`・`priorThroughYear` | `Result<FixedAssetDraft>`。`DEPRECIATION_METHOD_UNSUPPORTED` は 3 つの方法以外だけ。定額法: `useful_life_years` が率の表にない・取得日に率がない → `USEFUL_LIFE_UNSUPPORTED`。一括償却: `LUMP_SUM_COST_OUT_OF_RANGE`、`useful_life_years` を持つ → `VALIDATION`。供用日 < 取得日 → `VALIDATION`。累計・累計の年の不整合 → `PRIOR_ACCUMULATED_INVALID`。他の方法の `linkedJournalId` → `VALIDATION`。少額の年間の上限は `small_asset_28_2` だけを数える（今のまま） | FR-001〜004, R1, R4, INV-21 |
| `proposeDepreciationAdjustment(asset, fiscalYear, accounts, params)` | `depreciation.ts`（変更） | `params = { rates, taxParameters }` | `Result<AdjustmentProposal \| null>`。data-model §2.3 の形。除却損の科目がなければ `ACCOUNT_NOT_FOUND`（`details.code: "5300"`）。登録済みの判定は呼び出す側（今のまま） | FR-009, FR-016, INV-23, INV-57 |
| `validateDeferredAsset(draft, { accounts })` | `deferred-asset.ts`（新規） | 名称、総額、開業日、累計、累計の年、勘定、備考 | `Result<DeferredAssetDraft>`（`ASSET_ACCOUNT_INVALID`、`PRIOR_ACCUMULATED_INVALID`、`VALIDATION`） | FR-012, R5 |
| `deferredAmortizationYear(asset, fiscalYear, { decisions, activeRefs, taxParameters })` | `deferred-asset.ts` | `decisions`: 全年度の決定、`activeRefs`: 有効な仕訳の結びついた（年度）の集合 | `Result<DeferredAmortizationView>`（data-model §2.1。`TAX_PARAMETER_MISSING`） | FR-013, R5, INV-58 |
| `validateDeferredDecision(view, amount)` | `deferred-asset.ts` | | `Result<number>`（`amount > view.openingBalance` → `DEFERRED_AMORTIZATION_OVER_LIMIT`（`details.limit`）、負・非整数 → `VALIDATION`） | FR-014, INV-58 |
| `proposeDeferredAmortization(asset, view, fiscalYear, accounts)` | `deferred-asset.ts` | | `Result<AdjustmentProposal \| null>`（決定がない・0 円・登録済みは null） | FR-015〜017, INV-23 |
| `deferredRows(assets, fiscalYear, ctx)` | `deferred-asset.ts` | | `DepreciationRow[]`（`source: "deferred_asset"`、決定の額 > 0 の年度だけ） | FR-019, R11 |
| `checkAssetRegister({ fiscalYear, accounts, opening, fixedAssets, deferredAssets, ... })` | `asset-register.ts`（新規） | `opening` は 001 の期首残高 | `BlueReturnWarning[]`（`ASSET_REGISTER_MISMATCH`。照合する勘定・飛ばす勘定は R10） | FR-020, INV-59 |
| `buildBlueReturn(input)` | `build.ts`（変更） | 入力に `straightLineRates`、`deferredAssets`、`deferredAmortizations`、`adjustmentRefsAll`（全年度の参照と仕訳の状態。開業費の有効な額に使う）を足す | 3 ページに定額法・一括償却・開業費の行（`depreciationRows` + `deferredRows`）、警告に `ASSET_REGISTER_MISMATCH`・`DEPRECIATION_PARAMETER_MISSING`。`DEFERRED_ASSET_NOT_AMORTIZED` はその勘定の開業費にその年度の決定があれば出さない（`buildPage4` に決定を渡す） | FR-015, FR-018〜020 |
| `blueReturnToCsv` | `csv.ts`（変更） | | 3 ページの行に 償却率・本年中の償却期間 を足す | R11 |

## 3. ユースケース

`usecases/blue-return.ts`（003）を変更し、開業費は `usecases/deferred-assets.ts`（新規）に置く。

| 関数 | 依存 | 説明 |
|---|---|---|
| `listFixedAssets(deps, { fiscalYear? })`（変更） | `ClosingReadDeps` | 各資産に `depreciation: Depreciation \| null` と、計算できないときの `depreciationError: { code, details } \| null` を付ける |
| `saveFixedAsset(deps, params)`（変更） | `ClosingSettingsDeps` | 更新で計算に効く項目が変わり、その資産に有効な償却の仕訳があれば 409 `DEPRECIATION_JOURNAL_EXISTS`（`details.years`）。判定は `closing.listAdjustmentRefsBySource` と `ledger.getJournal(id).status`（同じ `ClosingUnitOfWork` の中、R12。今の `inClosingTx` は `masters`・`closing` だけを渡すので、`ClosingTxDeps` に `ledger: Pick<LedgerRepository, "getJournal">` を足して `tx.ledger` を渡す） |
| `disposeFixedAsset(deps, params)`（変更） | 同上 | 除却の年度以後に有効な償却の仕訳があれば 409 `DEPRECIATION_JOURNAL_EXISTS`。除却の日は供用日以後（R8）。`disposalKind`（`scrap` / `sale`、省略時 `scrap`）を受け取り保存する |
| `getAdjustmentProposals(deps, { fiscalYear })`（変更） | 003 と同じ | 締め済みの年度は `depreciation`・`deferred_amortization` の案を返さない（FR-021）。資産は `startYear` 以後の年度ごとに案を作る（取得の年度だけではない）。開業費の案を最後に足す |
| `commitAdjustment(deps, params)`（変更） | 003 と同じ | `kind: "deferred_amortization"` を足す（`rebuildProposal` の分岐）。参照は `deferredAssetId` に出所を入れる。作り直しと比較は 003 のまま |
| `listDeferredAssets(deps, { fiscalYear? })` | `ClosingReadDeps` | 個人の事業体だけ。`fiscalYear` があれば各開業費に `amortization: DeferredAmortizationView \| null` を付ける |
| `saveDeferredAsset(deps, params & { id?, reason? })` | `ClosingSettingsDeps` | `validateDeferredAsset` → 計算に効く項目の変更は有効な仕訳があれば 409 → 保存 → `closing_audit_log`（`deferred_asset`、create / update） |
| `decideDeferredAmortization(deps, { deferredAssetId, fiscalYear, amount })` | `ClosingSettingsDeps` | 1 つの `ClosingUnitOfWork` で: 年度がない → `VALIDATION`、締め済み → `PERIOD_CLOSED`、`startYear` より前 → `VALIDATION`、その年度に有効な仕訳 → 409 `DEPRECIATION_JOURNAL_EXISTS`、`validateDeferredDecision` → upsert → `closing_audit_log`（`deferred_amortization`）。`Result<{ amortization: DeferredAmortizationView, proposal: AdjustmentProposal \| null }>` |
| `getBlueReturn(deps, { fiscalYear })`（変更） | 003 と同じ | `buildBlueReturn` に率・開業費・決定・全年度の参照を渡す |

## 4. ポート（`packages/db` が実装。`ClosingStore` に追加）

```ts
interface ClosingStore {
  // 003 のメソッドに追加
  listStraightLineRates(): StraightLineRate[]
  listDeferredAssets(): DeferredAsset[]
  upsertDeferredAsset(row: DeferredAsset): void
  /** 全年度（開業費の期首の残高は前の年度の決定から求める） */
  listDeferredAmortizations(): DeferredAmortization[]
  upsertDeferredAmortization(row: DeferredAmortization): void
  /** 出所ごとの参照（全年度）。変更の制限（R12）と開業費の有効な額に使う */
  listAdjustmentRefsBySource(source: { assetId: string } | { deferredAssetId: string }): AdjustmentRef[]
}
```

`insertAdjustmentRef` は `deferredAssetId` を書く。`FakeClosingStore`（`packages/domain/test/fakes/`）にも同じメソッドを足す。
