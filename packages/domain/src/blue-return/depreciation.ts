import type { AdjustmentProposal } from "@trebuchet/schema";
import { DRAWINGS_ACCOUNT_CODE } from "../carry-forward.ts";
import { formatSignedAmount } from "../reports/warnings.ts";
import {
  type Account,
  domainError,
  err,
  type FixedAsset,
  type LineDraft,
  ok,
  type Result,
  type TaxParameter,
} from "../types.ts";
import { computeHomeUse } from "./home-use.ts";
import { resolveTaxParameter } from "./tax-parameters.ts";

/** 減価償却費の科目コード（初期セットの 5180。決算書の欄18） */
export const DEPRECIATION_ACCOUNT_CODE = "5180";

const RATIO_DENOMINATOR = 10000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 資産の登録の入力。id は更新のときだけ（編集中の資産を年間の上限の合計から除くのに使う） */
export type FixedAssetDraft = Omit<
  FixedAsset,
  "id" | "createdAt" | "updatedAt" | "disposedOn" | "disposalKind"
> & {
  id?: string;
};

const blankToNull = (s: string | null | undefined): string | null => {
  const t = s?.trim() ?? "";
  return t === "" ? null : t;
};

const yearOf = (date: string) => date.slice(0, 4);

/**
 * 資産の登録を検証する（FR-018〜020、R7、INV-21）。方法は少額の特例だけ（DEPRECIATION_METHOD_UNSUPPORTED）、
 * 資産の勘定は区分が資産の科目（ASSET_ACCOUNT_INVALID）。取得の日に基準額・年間の上限が適用されなければ
 * SMALL_ASSET_NOT_APPLICABLE、取得価額が基準額以上なら SMALL_ASSET_OVER_THRESHOLD
 * （details.threshold・effectiveFrom）、同じ年（1〜12月）に取得した特例の資産の取得価額の合計（除却したか
 * どうかに関わらない。特例を使ったため。draft.id と同じ資産は除く）に今回を足して上限を超えれば
 * SMALL_ASSET_ANNUAL_LIMIT_EXCEEDED
 * （details.limit・total）。名前・備考の空白を除き、空の数量・備考は null にした入力を返す
 */
export function validateFixedAsset(
  draft: FixedAssetDraft,
  sameYearAssets: readonly FixedAsset[],
  params: { accounts: readonly Account[]; taxParameters: readonly TaxParameter[] },
): Result<FixedAssetDraft> {
  const fail = (field: string, message: string) =>
    err(domainError("VALIDATION", message, { field }));
  const name = draft.name.trim();
  if (name === "") return fail("name", "資産名を入力してください");
  if (draft.method !== "small_asset_28_2") {
    return err(
      domainError(
        "DEPRECIATION_METHOD_UNSUPPORTED",
        "償却の方法は少額減価償却資産の特例（措置法28条の2）だけ選べます",
        { field: "method", method: draft.method },
      ),
    );
  }
  const account = params.accounts.find((a) => a.id === draft.assetAccountId);
  if (account === undefined || account.category !== "asset") {
    return err(
      domainError("ASSET_ACCOUNT_INVALID", "資産の勘定は区分が資産の科目に限ります", {
        field: "assetAccountId",
        accountId: draft.assetAccountId,
        allowedCategory: "asset",
      }),
    );
  }
  if (!Number.isSafeInteger(draft.acquisitionCost) || draft.acquisitionCost <= 0) {
    return fail("acquisitionCost", "取得価額は1円以上の整数で入力してください");
  }
  if (
    !Number.isInteger(draft.businessRatio) ||
    draft.businessRatio < 0 ||
    draft.businessRatio > RATIO_DENOMINATOR
  ) {
    return fail("businessRatio", "事業専用割合は 0〜100% で入力してください");
  }
  if (!DATE_PATTERN.test(draft.acquiredOn) || Number.isNaN(Date.parse(draft.acquiredOn))) {
    return fail("acquiredOn", "取得年月日は YYYY-MM-DD で入力してください");
  }

  const threshold = resolveTaxParameter(
    "SMALL_ASSET_THRESHOLD",
    draft.acquiredOn,
    params.taxParameters,
  );
  const limit = resolveTaxParameter(
    "SMALL_ASSET_ANNUAL_LIMIT",
    draft.acquiredOn,
    params.taxParameters,
  );
  if (threshold === undefined || limit === undefined) {
    const rows = params.taxParameters.filter((p) => p.key === "SMALL_ASSET_THRESHOLD");
    const appliesFrom = rows.map((p) => p.effectiveFrom).sort()[0] ?? null;
    const ends = rows.map((p) => p.effectiveTo);
    const appliesTo = ends.includes(null) ? null : (ends.sort().at(-1) ?? null);
    return err(
      domainError(
        "SMALL_ASSET_NOT_APPLICABLE",
        `取得の日（${draft.acquiredOn}）には少額減価償却資産の特例が適用されません`,
        { field: "acquiredOn", acquiredOn: draft.acquiredOn, appliesFrom, appliesTo },
      ),
    );
  }
  if (draft.acquisitionCost >= threshold.value) {
    return err(
      domainError(
        "SMALL_ASSET_OVER_THRESHOLD",
        `取得価額が基準額（${formatSignedAmount(threshold.value)} 円）以上のため、少額減価償却資産の特例は使えません`,
        {
          field: "acquisitionCost",
          threshold: threshold.value,
          effectiveFrom: threshold.effectiveFrom,
        },
      ),
    );
  }
  const year = yearOf(draft.acquiredOn);
  const others = sameYearAssets
    .filter(
      (a) => a.id !== draft.id && a.method === "small_asset_28_2" && yearOf(a.acquiredOn) === year,
    )
    .reduce((s, a) => s + a.acquisitionCost, 0);
  const total = others + draft.acquisitionCost;
  if (total > limit.value) {
    return err(
      domainError(
        "SMALL_ASSET_ANNUAL_LIMIT_EXCEEDED",
        `${year}年に特例を使う資産の取得価額の合計（${formatSignedAmount(total)} 円）が年間の上限（${formatSignedAmount(limit.value)} 円）を超えます`,
        { field: "acquisitionCost", limit: limit.value, total },
      ),
    );
  }
  return ok({
    ...draft,
    name,
    quantity: blankToNull(draft.quantity),
    note: blankToNull(draft.note),
    usefulLifeYears: draft.usefulLifeYears ?? null,
  });
}

/** 決算書3ページの減価償却費の計算の値（イ〜ヌ） */
export type Depreciation = {
  /** 取得価額 */
  cost: number;
  /** 償却の基礎になる金額 */
  base: number;
  /** 本年分の普通償却費 */
  ordinary: number;
  /** 本年分の償却費合計 */
  total: number;
  /** 事業専用割合（万分率） */
  businessRatio: number;
  /** 本年分の必要経費算入額 = ⌊取得価額 × 事業専用割合 / 10000⌋（取得した年） */
  deductible: number;
  /** 未償却残高 */
  closingBookValue: number;
};

/**
 * 減価償却費の計算（FR-021、R7、INV-21）。方法は少額の特例だけで、取得した年に取得価額の全額を償却し、
 * 未償却残高は 0。取得した年以外の償却費・必要経費算入額は 0。年は取得年月日の年（個人は暦年）
 */
export function depreciate(asset: FixedAsset, fiscalYear: number): Depreciation {
  const acquiredNow = yearOf(asset.acquiredOn) === String(fiscalYear);
  const base = acquiredNow ? asset.acquisitionCost : 0;
  return {
    cost: asset.acquisitionCost,
    base,
    ordinary: base,
    total: base,
    businessRatio: asset.businessRatio,
    deductible: acquiredNow
      ? computeHomeUse(asset.acquisitionCost, asset.businessRatio).business
      : 0,
    closingBookValue: 0,
  };
}

/**
 * 年度の3ページの表に載せる資産か。取得した年、または未償却残高があり、年度末日までに除却していない。
 * 年度は取得年月日と同じ暦年（個人）
 */
export function isDepreciationRow(asset: FixedAsset, fiscalYear: number): boolean {
  const yearEnd = `${fiscalYear}-12-31`;
  if (asset.acquiredOn > yearEnd) return false;
  if (asset.disposedOn !== null && asset.disposedOn <= yearEnd) return false;
  return (
    yearOf(asset.acquiredOn) === String(fiscalYear) ||
    depreciate(asset, fiscalYear).closingBookValue > 0
  );
}

/**
 * 減価償却の仕訳の案（FR-021〜022、R7、INV-23）。「減価償却費 / 資産の勘定」（取得価額）と、
 * 家事分があれば「事業主貸 / 減価償却費」（取得価額 − 必要経費算入額）。日付は年度末日、
 * 行の税区分は対象外（内部の振替）。結びつけた仕訳（linkedJournalId）がある資産、取得した年以外、
 * 年度末日までに除却した資産は案なし（null）。登録済みの案を除くのは呼び出す側（出所の参照を読む）
 */
export function proposeDepreciationAdjustment(
  asset: FixedAsset,
  fiscalYear: number,
  accounts: readonly Account[],
): Result<AdjustmentProposal | null> {
  if (asset.linkedJournalId !== null) return ok(null);
  if (yearOf(asset.acquiredOn) !== String(fiscalYear) || !isDepreciationRow(asset, fiscalYear)) {
    return ok(null);
  }
  const expense = accounts.find((a) => a.code === DEPRECIATION_ACCOUNT_CODE);
  if (expense === undefined) {
    return err(
      domainError("ACCOUNT_NOT_FOUND", "減価償却費の科目（5180）がありません", {
        code: DEPRECIATION_ACCOUNT_CODE,
      }),
    );
  }
  const drawings = accounts.find((a) => a.code === DRAWINGS_ACCOUNT_CODE);
  if (drawings === undefined) {
    return err(
      domainError("ACCOUNT_NOT_FOUND", "事業主貸の科目（3090）がありません", {
        code: DRAWINGS_ACCOUNT_CODE,
      }),
    );
  }
  const { deductible } = depreciate(asset, fiscalYear);
  const home = asset.acquisitionCost - deductible;
  // 内部の振替で仕入ではない。課税期間でも既定（費用は仕入 10%）にしない
  const taxCategory = "OUT_OF_SCOPE" as const;
  const line = (side: LineDraft["side"], accountId: string, amount: number): LineDraft => ({
    side,
    accountId,
    amount,
    taxCategory,
  });
  const lines: LineDraft[] = [
    line("debit", expense.id, asset.acquisitionCost),
    line("credit", asset.assetAccountId, asset.acquisitionCost),
  ];
  if (home > 0) {
    lines.push(line("debit", drawings.id, home), line("credit", expense.id, home));
  }
  const percent = `${asset.businessRatio / 100}%`;
  return ok({
    kind: "depreciation",
    sourceId: asset.id,
    journal: {
      date: `${fiscalYear}-12-31`,
      memo: `減価償却費の計上（${asset.name} 少額減価償却資産 事業専用割合 ${percent}）`,
      lines,
    },
    // 少額の特例は 009 の償却の形で埋める（月数・率・除却は持たない。T011 で方法ごとの値になる）
    breakdown: {
      method: "small_asset_28_2",
      acquisitionCost: asset.acquisitionCost,
      businessRatio: asset.businessRatio,
      depreciation: asset.acquisitionCost,
      deductible,
      months: null,
      ratePermille: null,
      openingBookValue: asset.acquisitionCost,
      closingBookValue: 0,
      disposalKind: null,
      disposalAmount: 0,
      disposalDeductible: 0,
    },
  });
}
