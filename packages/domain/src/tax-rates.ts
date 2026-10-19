import type { TaxCategoryCode } from "@trebuchet/schema";
import { TAX_CATEGORIES } from "./seed/tax-categories.ts";
import type { TaxRate } from "./types.ts";

const TAXABLE = new Set<TaxCategoryCode>(
  TAX_CATEGORIES.filter((c) => c.kind !== null).map((c) => c.code),
);

/** 課税の区分（売上・仕入）か */
export function isTaxableCategory(code: TaxCategoryCode): boolean {
  return TAXABLE.has(code);
}

/**
 * 税区分と日付から税率（百分率の整数）を決める（INV-10, Constitution VI）。
 * effectiveFrom <= date の行のうち最新のもの。課税の区分以外、または該当する行がなければ undefined。
 */
export function resolveTaxRate(
  categoryCode: TaxCategoryCode,
  date: string,
  rates: readonly TaxRate[],
): number | undefined {
  if (!isTaxableCategory(categoryCode)) return undefined;
  let latest: TaxRate | undefined;
  for (const r of rates) {
    if (r.categoryCode !== categoryCode || r.effectiveFrom > date) continue;
    if (latest === undefined || r.effectiveFrom > latest.effectiveFrom) latest = r;
  }
  return latest?.rate;
}
