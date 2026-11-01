# Contract: HTTP API（009-depreciation-deferred）

001 の [http-api.md](../../001-ledger-core/contracts/http-api.md) の規約と、003 の [http-api.md](../../003-tax-return/contracts/http-api.md) の API をそのまま使う。追加・変更するものだけを書く。入出力の正本は `packages/schema/src/blue-return.ts` の Zod 定義。年度は `:year`（`validate("param", FiscalYearParam)`）。ルートは `respond(c, result, ...)` で返す（AGENTS.md）。

## 1. 追加するエラーコード

| HTTP | code | 発生条件 | 要件 |
|---|---|---|---|
| 422 | `USEFUL_LIFE_UNSUPPORTED` | 定額法で、耐用年数が償却率の表にない（例 1 年、51 年）、または取得日に適用される率がない（2007-03-31 以前の取得）。`details.usefulLifeYears`、`acquiredOn` | FR-001, Edge Cases, R2 |
| 422 | `LUMP_SUM_COST_OUT_OF_RANGE` | 一括償却資産の取得価額が範囲外。`details.min`、`max` | FR-003, R4 |
| 422 | `PRIOR_ACCUMULATED_INVALID` | 前年までの累計が負、上限（定額法は取得価額 − 1、一括償却・開業費は総額）を超える、累計があるのに年がない、年が供用（開業）の年より前、少額の特例で累計を指定 | FR-002, Edge Cases, R1 |
| 422 | `TAX_PARAMETER_MISSING` | 登録・決定で、日付に該当する税制の値（一括償却の範囲・年数、開業費の月数）がない。`details.key`、`date` | FR-022, Edge Cases, R13 |
| 422 | `DEFERRED_AMORTIZATION_OVER_LIMIT` | 開業費の償却額が上限（期首の未償却残高）を超える。`details.limit` | FR-014 |
| 409 | `DEPRECIATION_JOURNAL_EXISTS` | 資産・開業費の計算に効く項目の変更、除却、開業費の決定の変更で、対象の年度に有効な償却の仕訳がある。`details.years`（仕訳のある年度）、`journalIds` | Edge Cases, R12 |

- 003 の `DEPRECIATION_METHOD_UNSUPPORTED` は残す（列挙の外の値。Zod を通るのは 3 つだけなので、domain を直接呼ぶときだけ起きる）
- 締め済みの年度は 001 の `PERIOD_CLOSED`。案がなければ 003 の `ADJUSTMENT_NOT_NEEDED`、金額が変わっていれば `ADJUSTMENT_CHANGED`
- エラーコードを足したら、`grep -rn` で同じ値を参照するテストと web のエラー表示（`features/fixed-assets/`）を直す（AGENTS.md）

## 2. 固定資産台帳（003 を変更）

| メソッド | パス | 入力 | 出力 | 要件 |
|---|---|---|---|---|
| GET | `/entities/:id/fixed-assets` | `?year=` | 200 `{ assets: (FixedAsset & { depreciation: Depreciation \| null, depreciationError: { code, details } \| null })[] }` | FR-005〜011, R3, R4 |
| POST | `/entities/:id/fixed-assets` | `FixedAssetInput`（下） | 201 `{ asset }` | FR-001〜004 |
| PUT | `/entities/:id/fixed-assets/:assetId` | `FixedAssetInput & { reason }` | 200 `{ asset }`。409 `DEPRECIATION_JOURNAL_EXISTS` | R12 |
| POST | `/entities/:id/fixed-assets/:assetId/dispose` | `{ disposedOn, reason, disposalKind?: "scrap" \| "sale" }`（省略時 `scrap`。`sale` なら未償却残高を事業主貸へ振り替える案、R8） | 200 `{ asset }`。409 `DEPRECIATION_JOURNAL_EXISTS` | FR-009, FR-011, R8 |

`FixedAssetInput` に足す項目:

| 項目 | 型 | 説明 |
|---|---|---|
| `method` | `"small_asset_28_2" \| "straight_line" \| "lump_sum"` | `DepreciationMethod` |
| `inServiceOn` | `DateString \| null`（省略可） | 事業の用に供した日。null なら取得日 |
| `priorAccumulated` | 0 以上の整数（省略時 0） | 前年までの償却累計額 |
| `priorThroughYear` | 4 桁の年 \| null（省略可） | 累計が何年分までか |

`usefulLifeYears` は今のまま（定額法で必須かどうかは domain が判定する）。

## 3. 繰延資産（開業費）（新規）

| メソッド | パス | 入力 | 出力 | 要件 |
|---|---|---|---|---|
| GET | `/entities/:id/deferred-assets` | `?year=` | 200 `{ deferredAssets: (DeferredAsset & { amortization: DeferredAmortizationView \| null })[] }` | FR-012〜013 |
| POST | `/entities/:id/deferred-assets` | `DeferredAssetInput`: `{ name, totalAmount, openedOn, priorAccumulated?, priorThroughYear?, accountId, note? }` | 201 `{ deferredAsset }` | FR-012 |
| PUT | `/entities/:id/deferred-assets/:deferredAssetId` | `DeferredAssetInput & { reason }` | 200 `{ deferredAsset }`。409 `DEPRECIATION_JOURNAL_EXISTS` | R12 |
| PUT | `/entities/:id/deferred-assets/:deferredAssetId/amortizations/:year` | `{ amount }`（0 以上の整数） | 200 `{ amortization: DeferredAmortizationView, proposal: AdjustmentProposal \| null }`。422 `DEFERRED_AMORTIZATION_OVER_LIMIT`、409 `DEPRECIATION_JOURNAL_EXISTS`、`PERIOD_CLOSED` | FR-014〜015 |

- パスの検査は `FiscalYearParam.extend({ deferredAssetId: z.string() })`（003 の `TaxReturnMemoParam` と同じ形）
- 正の額の決定は、仕訳をまだ作らない。仕訳は §4 の案の確定で登録する（R5）

## 4. 決算整理の仕訳の案（003 を変更）

| メソッド | パス | 入力 | 出力 | 要件 |
|---|---|---|---|---|
| GET | `/entities/:id/blue-return/:year/adjustments` | — | 200 `{ proposals: AdjustmentProposal[] }`。按分 → 資産（台帳の順、`startYear` 以後のすべての年度の資産）→ 開業費。締め済みの年度は償却・開業費の案を含まない | FR-016〜017, FR-021 |
| POST | `/entities/:id/blue-return/:year/adjustments` | `{ kind, sourceId, expected: { amount } }`。`kind` に `deferred_amortization`（`sourceId` は開業費の ID） | 201 `{ journal, ref }` | FR-016〜017 |

- `AdjustmentProposal.breakdown` の形は data-model §2.1（償却の形を拡張、開業費の形を追加）
- `expected.amount` は今のまま案の借方合計（除却の年度は 償却 + 残りの未償却残高（除却損または売却の振替）+ 家事分の振替 の合計）

## 5. 決算書（003 の出力を変更）

| メソッド | パス | 変更 |
|---|---|---|
| GET | `/entities/:id/blue-return/:year` | `page3.depreciation` の行に `source`、`ratePermille`、`months`、`disposedOn` を足し、`method` に `straight_line`・`lump_sum`・`deferred`。警告のコードに `ASSET_REGISTER_MISMATCH`、`DEPRECIATION_PARAMETER_MISSING`（data-model §2.1） |
| GET | `/entities/:id/blue-return/:year/csv` | 3 ページの行に 償却率・本年中の償却期間 の値を足す（R11） |

web は `features/fixed-assets/api.ts` と新しい `features/deferred-assets/api.ts`（または `fixed-assets/api.ts` に同居）に query key と呼び出しを置き、案の登録の後は `invalidateLedger(queryClient, entityId)`。`apps/web/test/mock-api.ts` に `/deferred-assets` の既定の応答を足す（AGENTS.md）。
