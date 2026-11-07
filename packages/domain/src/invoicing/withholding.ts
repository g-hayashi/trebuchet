import type { InvoiceTaxDisplay, TaxBreakdownEntry } from "@trebuchet/schema";
import { resolveTaxParameter } from "../blue-return/tax-parameters.ts";
import { domainError, err, ok, type Result, type TaxParameter } from "../types.ts";

/** 源泉徴収（013）。式は research R1、対象額は R3。金額はすべて整数で計算する */

/**
 * 源泉徴収の対象額（R3）。`separate`（消費税相当額を区分して表示する）で税率つきの内訳があれば
 * `total − Σ tax`（税抜）、それ以外は `total`（税込）。税率なしの明細は total に含まれたまま。
 */
export function withholdingBase(
  amounts: { total: number; taxBreakdown: readonly TaxBreakdownEntry[] },
  taxDisplay: InvoiceTaxDisplay,
): number {
  if (taxDisplay !== "separate" || amounts.taxBreakdown.length === 0) return amounts.total;
  return amounts.total - amounts.taxBreakdown.reduce((sum, row) => sum + row.tax, 0);
}

/**
 * 源泉徴収税額（INV-73、R1）。`base ≤ 0` は 0、それ以外は
 * `floor((min(base, T) × L + max(0, base − T) × H) / 10000)`（T は境目、L・H は万分率）。
 * `base < 1e12` なので積は `2^53` に収まる。T・L・H は `date` に有効な税制の値から決め、
 * 1 つでもなければ `WITHHOLDING_RATE_MISSING`（details `{ date }`）。
 */
export function withholdingTax(
  base: number,
  date: string,
  params: readonly TaxParameter[],
): Result<number> {
  const threshold = resolveTaxParameter("WITHHOLDING_THRESHOLD", date, params)?.value;
  const low = resolveTaxParameter("WITHHOLDING_RATE_LOW", date, params)?.value;
  const high = resolveTaxParameter("WITHHOLDING_RATE_HIGH", date, params)?.value;
  if (threshold === undefined || low === undefined || high === undefined) {
    return err(
      domainError("WITHHOLDING_RATE_MISSING", "源泉徴収の税率が設定されていない日付です", { date }),
    );
  }
  if (base <= 0) return ok(0);
  return ok(
    Math.floor((Math.min(base, threshold) * low + Math.max(0, base - threshold) * high) / 10000),
  );
}
