import type { TaxParameter, TaxParameterKey } from "../types.ts";

/**
 * キーと日付から税制の値の行を決める（Constitution VI、research R3）。
 * effectiveFrom <= date <= effectiveTo（effectiveTo が null なら期限なし）の行のうち、effectiveFrom が最新のもの。
 * 該当する行がなければ undefined。
 * `resolveTaxRate`（tax-rates.ts）と同じ選び方に、適用終了日の条件を足したもの。
 */
export function resolveTaxParameter(
  key: TaxParameterKey,
  date: string,
  params: readonly TaxParameter[],
): TaxParameter | undefined {
  let latest: TaxParameter | undefined;
  for (const p of params) {
    if (p.key !== key || p.effectiveFrom > date) continue;
    if (p.effectiveTo !== null && date > p.effectiveTo) continue;
    if (latest === undefined || p.effectiveFrom > latest.effectiveFrom) latest = p;
  }
  return latest;
}
