# 定額法・一括償却資産・開業費（009）

仕様: `specs/009-depreciation-deferred/`。償却を属性から計算し、開業費の決定だけ保存する理由: [ADR 0012](../adr/0012-multi-year-depreciation.md)。003 の決算整理の仕組み（案 → 利用者が確かめて仕訳を登録）に、複数年の償却を足した。

| 層 | 場所 |
|---|---|
| 償却の計算（定額法、一括償却、開業費の上限・目安・決定、台帳と帳簿の照合。純関数） | `packages/domain/src/blue-return/`（`straight-line.ts`、`lump-sum.ts`、`deferred-asset.ts`、`asset-register.ts`。少額の特例は 003 の `depreciation.ts`）、償却率の正本は `packages/domain/src/seed/depreciation-rates.ts` |
| ユースケース | `packages/domain/src/usecases/deferred-assets.ts`（003 の `blue-return.ts` の `getAdjustmentProposals`・`commitAdjustment` も開業費を扱う） |
| 永続化（償却率の表 `straight_line_rates`、開業費、年度ごとの決定） | `packages/db/src/closing-repository.ts` |
| HTTP | `apps/server/src/routes/deferred-assets.ts`（資産は 003 の `fixed-assets.ts`） |
| 画面 | `apps/web/src/features/deferred-assets/`（`api.ts`、`DeferredAssetForm.tsx`、`AmortizationDecision.tsx`）、資産の画面 `routes/e/$entityId/fixed-assets/` |

- **償却率の表の足し方**（耐用年数省令の改正など）: 手順は[003](003-tax-return.md)の「税制の値の足し方」と同じ（`seed/depreciation-rates.ts` が正本。マイグレーションの両方に、適用の期間と出典の URL つきで足す）。`packages/db/test/closing-repository.test.ts`（`listStraightLineRates`）が値の一致を確かめる。率は取得日で選ぶ（009/R2）。
- **定額法・一括償却の各年度の償却費は、資産の属性（取得価額、方法、耐用年数、供用日、前年までの累計、除却日）と税制の値から計算し、保存しない**（ADR 0012）。登録した仕訳の金額を計算に使わない。償却を忘れた年度も償却したものとして残高が減る（強制償却）。
- **開業費だけ、年度ごとの償却額の決定（0 円を含む）を `deferred_amortizations` に保存する**。上限は期首の未償却残高（取り消されていない仕訳に結びつく決定を差し引く）、目安は 60 か月の均等。上限を超えれば 422 `DEFERRED_AMORTIZATION_OVER_LIMIT`（`details.limit`）。0 円は記録だけで、仕訳の案を作らない（任意償却）。
- **登録済みの償却の仕訳がある資産・開業費は、計算に効く項目を変えると 409 `DEPRECIATION_JOURNAL_EXISTS`**（`details.years`）。仕訳を取り消してから変える。名称・備考だけの変更は通る。
- **定額法の除却は種類（`disposal_kind`）で分ける**: 廃棄は除却の年度の月割りの償却と残りの未償却残高（除却損。家事分は事業主貸）を 1 つの案にする。売却は残高を事業主貸へ振り替える（譲渡所得の計算は範囲外）。一括償却は除却しても額が変わらない。
- 実データの照合 `pnpm verify:tax-return` の `--closing` の JSON は 009 で広がった（`assets` の `method`・`inServiceOn` など、`deferredAssets`。形はスクリプトの先頭のコメント）。

