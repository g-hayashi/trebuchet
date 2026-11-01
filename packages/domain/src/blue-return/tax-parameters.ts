import type { StraightLineRate, TaxParameter, TaxParameterKey } from "../types.ts";

/**
 * 耐用年数と取得日から定額法の償却率の行を決める（009 R2）。
 * `resolveTaxParameter` と同じ選び方（適用期間の中で effectiveFrom が最新の行）。外れたら undefined。
 */
export function resolveStraightLineRate(
  usefulLifeYears: number,
  acquiredOn: string,
  rates: readonly StraightLineRate[],
): StraightLineRate | undefined {
  let latest: StraightLineRate | undefined;
  for (const r of rates) {
    if (r.usefulLifeYears !== usefulLifeYears || r.effectiveFrom > acquiredOn) continue;
    if (r.effectiveTo !== null && acquiredOn > r.effectiveTo) continue;
    if (latest === undefined || r.effectiveFrom > latest.effectiveFrom) latest = r;
  }
  return latest;
}

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
