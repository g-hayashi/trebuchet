import type { InvoiceTaxDisplay, TaxBreakdownEntry, TaxCategoryCode } from "@trebuchet/schema";
import { defaultTaxCategory } from "../journal.ts";
import { isTaxableCategory, resolveTaxRate } from "../tax-rates.ts";
import { resolveTaxSetting, type TaxSettingDraft } from "../tax-settings.ts";
import type { TaxRate } from "../types.ts";
import { taxBreakdown } from "./amounts.ts";

/**
 * 請求書の消費税の扱い（005 R10）。売上の計上日で決める。
 * 発行の検査と案の作成が同じ関数を使い、売上の仕訳の税額（001 の `validateJournal`）と請求書の別記が食い違わないようにする
 */

/** 明細の税区分の既定 = 計上日の設定による売上高（収益の科目）の既定値（免税・設定の空白は対象外） */
export function defaultSalesTaxCategory(
  salesDate: string,
  taxSettings: readonly TaxSettingDraft[],
): TaxCategoryCode {
  return defaultTaxCategory(salesDate, "credit", { category: "revenue" }, taxSettings);
}

/**
 * 明細の税率（%）。免税の期間・課税でない区分は null。
 * 001 の `validateJournal` が貸方の行の `taxAmount` を求める条件と同じ
 */
export function itemTaxRate(
  taxCategory: TaxCategoryCode,
  salesDate: string,
  taxSettings: readonly TaxSettingDraft[],
  taxRates: readonly TaxRate[],
): number | null {
  const setting = resolveTaxSetting(salesDate, taxSettings);
  if (setting === undefined || setting.taxpayerStatus === "exempt") return null;
  if (!isTaxableCategory(taxCategory)) return null;
  return resolveTaxRate(taxCategory, salesDate, taxRates) ?? null;
}

/** 請求書の別記の内訳（税率ごと。税率なしの明細は載せない。API の `taxBreakdown`） */
export function taxBreakdownEntries(
  items: readonly { amount: number; taxRate: number | null }[],
): TaxBreakdownEntry[] {
  const entries: TaxBreakdownEntry[] = [];
  for (const row of taxBreakdown(items)) {
    if (row.rate === null) continue;
    entries.push({
      rate: row.rate,
      inclusive: row.inclusive,
      tax: row.tax,
      exclusive: row.exclusive,
    });
  }
  return entries;
}

/**
 * 写しに残す消費税の表示。設定が「別記」でも、計上日が免税（または設定の空白）なら「税込のみ」にする
 * （免税事業者の請求書に消費税額を書かない。FR-013）
 */
export function effectiveTaxDisplay(
  configured: InvoiceTaxDisplay | undefined,
  salesDate: string,
  taxSettings: readonly TaxSettingDraft[],
): InvoiceTaxDisplay {
  const setting = resolveTaxSetting(salesDate, taxSettings);
  if (setting === undefined || setting.taxpayerStatus === "exempt") return "inclusive_only";
  return configured ?? "inclusive_only";
}
