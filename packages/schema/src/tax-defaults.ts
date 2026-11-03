import type { TaxSettingInput } from "./masters.ts";
import type { AccountCategory, TaxCategoryCode } from "./primitives.ts";

/** 税区分の既定（FR-017）。免税・設定のない日付・未選択の科目は対象外。 */
export function defaultTaxCategory(
  date: string,
  account: { category: AccountCategory } | undefined,
  settings: readonly Pick<TaxSettingInput, "effectiveFrom" | "taxpayerStatus">[],
): TaxCategoryCode {
  let setting: (typeof settings)[number] | undefined;
  for (const candidate of settings) {
    if (
      candidate.effectiveFrom <= date &&
      (setting === undefined || candidate.effectiveFrom > setting.effectiveFrom)
    ) {
      setting = candidate;
    }
  }
  if (setting === undefined || setting.taxpayerStatus === "exempt" || account === undefined) {
    return "OUT_OF_SCOPE";
  }
  if (account.category === "revenue") return "SALES_10";
  if (account.category === "expense") return "PURCHASE_10";
  return "OUT_OF_SCOPE";
}
