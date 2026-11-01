import type { BlueReturnWarning } from "@trebuchet/schema";
import { debitNet, type OpeningInput } from "../reports/common.ts";
import { formatSignedAmount } from "../reports/warnings.ts";
import type { Account, FixedAsset } from "../types.ts";
import { type DepreciationParams, depreciate } from "./depreciation.ts";

export type AssetRegisterInput = {
  /** 暦年（個人） */
  fiscalYear: number;
  accounts: readonly Account[];
  /** その年度の 001 の期首残高（補助科目ごとの行。勘定ごとに合計する） */
  opening: readonly OpeningInput[];
  fixedAssets: readonly FixedAsset[];
  /** 償却率・税制の値（`depreciate` に渡す） */
  params: DepreciationParams;
};

/** 台帳に載る（台帳が期首を計算する）方法。少額の特例は台帳の期首に 0 を足すだけで、勘定を対象にしない */
const isRegisterMethod = (asset: FixedAsset) =>
  asset.method === "straight_line" || asset.method === "lump_sum";

/**
 * 帳簿の期首と台帳の期首の照合（FR-020、R10、INV-59。自動では直さない）。
 *
 * - 対象の勘定: 定額法・一括償却の資産（その年度の末日までに取得したもの）が使う資産の勘定。
 *   少額の特例の資産だけが使う勘定は対象にしない（開業費の勘定は T019 で足す）
 * - 帳簿の期首: 勘定ごとの期首残高の合計（借方を正）
 * - 台帳の期首: 年度の期首より前に取得した資産の期首の未償却残高の合計（`depreciate` の
 *   `openingBookValue`。定額法は除却の年度が前なら 0、一括償却は除却しても残高、少額の特例は 0）
 * - 飛ばす勘定: 台帳がその年度を計算しない資産（`priorThroughYear ≥ 年度`）がある勘定、
 *   台帳の期首を計算できない資産（償却率がないなど）がある勘定
 *
 * 差（帳簿 − 台帳）がある勘定ごとに警告 `ASSET_REGISTER_MISMATCH` を 1 件。勘定の並びは科目コード順
 */
export function checkAssetRegister(input: AssetRegisterInput): BlueReturnWarning[] {
  const { fiscalYear, accounts, opening, fixedAssets, params } = input;
  const yearStart = `${String(fiscalYear).padStart(4, "0")}-01-01`;
  const yearEnd = `${String(fiscalYear).padStart(4, "0")}-12-31`;

  const book = new Map<string, number>();
  for (const o of opening) book.set(o.accountId, (book.get(o.accountId) ?? 0) + debitNet(o));

  const targets = fixedAssets.filter((a) => isRegisterMethod(a) && a.acquiredOn <= yearEnd);
  const targetAccountIds = [...new Set(targets.map((a) => a.assetAccountId))];
  const accountOf = new Map(accounts.map((a) => [a.id, a]));
  const keyOf = (id: string) => accountOf.get(id)?.code ?? id;
  targetAccountIds.sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));

  const warnings: BlueReturnWarning[] = [];
  for (const accountId of targetAccountIds) {
    const onAccount = fixedAssets.filter(
      (a) => a.assetAccountId === accountId && a.acquiredOn <= yearEnd,
    );
    const registered = onAccount.filter(isRegisterMethod);
    if (registered.some((a) => a.priorThroughYear !== null && a.priorThroughYear >= fiscalYear)) {
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
