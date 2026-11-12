import type { BlueReturnWarning } from "@trebuchet/schema";
import { debitNet, type OpeningInput } from "../reports/common.ts";
import { formatSignedAmount } from "../reports/warnings.ts";
import { compareText } from "../text.ts";
import type { Account, DeferredAmortization, DeferredAsset, FixedAsset } from "../types.ts";
import { deferredAmortizationYear } from "./deferred-asset.ts";
import { type DepreciationParams, depreciate } from "./depreciation.ts";

export type AssetRegisterInput = {
  /** 暦年（個人） */
  fiscalYear: number;
  accounts: readonly Account[];
  /** その年度の 001 の期首残高（補助科目ごとの行。勘定ごとに合計する） */
  opening: readonly OpeningInput[];
  fixedAssets: readonly FixedAsset[];
  /** 開業費（009 R10）。なければ空 */
  deferredAssets?: readonly DeferredAsset[];
  /** 開業費の全年度の決定。なければ空 */
  deferredDecisions?: readonly DeferredAmortization[];
  /** 開業費の ID → 有効な償却の仕訳が結びついた年度の集合（`activeDeferredYears`）。なければ空 */
  deferredActiveRefs?: ReadonlyMap<string, ReadonlySet<number>>;
  /** 償却率・税制の値（`depreciate` に渡す） */
  params: DepreciationParams;
};

/** 台帳に載る（台帳が期首を計算する）方法。少額の特例は台帳の期首に 0 を足すだけで、勘定を対象にしない */
const isRegisterMethod = (asset: FixedAsset) =>
  asset.method === "straight_line" || asset.method === "lump_sum";

/**
 * 帳簿の期首と台帳の期首の照合（FR-020、R10、INV-59。自動では直さない）。
 *
 * - 対象の勘定: 定額法・一括償却の資産と開業費（その年度の末日までに取得・開業したもの）が使う資産の勘定。
 *   少額の特例の資産だけが使う勘定、開業費を登録していない勘定は対象にしない
 * - 帳簿の期首: 勘定ごとの期首残高の合計（借方を正）
 * - 台帳の期首: 年度の期首より前に取得・開業したものの期首の未償却残高の合計（資産は `depreciate` の
 *   `openingBookValue`。定額法は除却の年度が前なら 0、一括償却は除却しても残高、少額の特例は 0。
 *   開業費は `deferredAmortizationYear` の上限 = 総額 − 累計 − 前の年度の有効な償却）
 * - 飛ばす勘定: 台帳がその年度を計算しない資産・開業費（`priorThroughYear ≥ 年度`）がある勘定、
 *   台帳の期首を計算できない資産・開業費（償却率・税制の値がないなど）がある勘定
 *
 * 差（帳簿 − 台帳）がある勘定ごとに警告 `ASSET_REGISTER_MISMATCH` を 1 件。勘定の並びは科目コード順
 */
export function checkAssetRegister(input: AssetRegisterInput): BlueReturnWarning[] {
  const { fiscalYear, accounts, opening, fixedAssets, params } = input;
  const deferredAssets = input.deferredAssets ?? [];
  const yearStart = `${String(fiscalYear).padStart(4, "0")}-01-01`;
  const yearEnd = `${String(fiscalYear).padStart(4, "0")}-12-31`;

  const book = new Map<string, number>();
  for (const o of opening) book.set(o.accountId, (book.get(o.accountId) ?? 0) + debitNet(o));

  const targets = fixedAssets.filter((a) => isRegisterMethod(a) && a.acquiredOn <= yearEnd);
  const deferredTargets = deferredAssets.filter((d) => d.openedOn <= yearEnd);
  const targetAccountIds = [
    ...new Set([
      ...targets.map((a) => a.assetAccountId),
      ...deferredTargets.map((d) => d.accountId),
    ]),
  ];
  const accountOf = new Map(accounts.map((a) => [a.id, a]));
  const keyOf = (id: string) => accountOf.get(id)?.code ?? id;
  targetAccountIds.sort((a, b) => compareText(keyOf(a), keyOf(b)));

  const warnings: BlueReturnWarning[] = [];
  for (const accountId of targetAccountIds) {
    const onAccount = fixedAssets.filter(
      (a) => a.assetAccountId === accountId && a.acquiredOn <= yearEnd,
    );
    const registered = onAccount.filter(isRegisterMethod);
    const deferredOnAccount = deferredTargets.filter((d) => d.accountId === accountId);
    if (
      registered.some((a) => a.priorThroughYear !== null && a.priorThroughYear >= fiscalYear) ||
      deferredOnAccount.some((d) => d.priorThroughYear !== null && d.priorThroughYear >= fiscalYear)
    ) {
      continue;
    }
    let registerOpening = 0;
    let computable = true;
    for (const a of registered) {
      if (a.acquiredOn >= yearStart) continue; // その年度に取得した資産は期首に含めない
      const d = depreciate(a, fiscalYear, params);
      if (!d.ok) {
        computable = false;
        break;
      }
      registerOpening += d.value.openingBookValue;
    }
    for (const d of deferredOnAccount) {
      if (!computable) break;
      if (d.openedOn >= yearStart) continue; // その年度に開業した開業費は期首に含めない
      const v = deferredAmortizationYear(d, fiscalYear, {
        decisions: input.deferredDecisions ?? [],
        activeRefs: input.deferredActiveRefs?.get(d.id) ?? new Set(),
        taxParameters: params.taxParameters,
      });
      if (!v.ok) {
        computable = false;
        break;
      }
      registerOpening += v.value.openingBalance;
    }
    if (!computable) continue;

    const bookOpening = book.get(accountId) ?? 0;
    const difference = bookOpening - registerOpening;
    if (difference === 0) continue;
    const accountName = accountOf.get(accountId)?.name ?? accountId;
    warnings.push({
      code: "ASSET_REGISTER_MISMATCH",
      message: `${accountName}の期首残高（${formatSignedAmount(bookOpening)} 円）が、減価償却の台帳の期首の未償却残高（${formatSignedAmount(registerOpening)} 円）と一致しません（差 ${formatSignedAmount(difference)} 円）`,
      details: { accountId, accountName, bookOpening, registerOpening, difference },
    });
  }
  return warnings;
}
