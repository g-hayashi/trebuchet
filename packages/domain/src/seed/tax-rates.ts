import type { TaxRate } from "../types.ts";

const NTA_KEIGEN =
  "https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/keigenzeiritsu.htm";

/**
 * 税率の正本（Constitution VI, data-model §2）。
 * DB へはマイグレーション 0001_integrity.sql で投入する（一致をテストで確認）。
 * 税制が改正されたら、こことマイグレーションの両方に effective_from つきの行を追加する（research R14）。
 */
export const TAX_RATES: readonly TaxRate[] = [
  { categoryCode: "SALES_10", rate: 10, effectiveFrom: "2019-10-01", sourceUrl: NTA_KEIGEN },
  { categoryCode: "PURCHASE_10", rate: 10, effectiveFrom: "2019-10-01", sourceUrl: NTA_KEIGEN },
  { categoryCode: "SALES_8R", rate: 8, effectiveFrom: "2019-10-01", sourceUrl: NTA_KEIGEN },
  { categoryCode: "PURCHASE_8R", rate: 8, effectiveFrom: "2019-10-01", sourceUrl: NTA_KEIGEN },
];
