import {
  defaultTaxCategory,
  type InvoiceTaxDisplay,
  type TaxBreakdownEntry,
  type TaxCategoryCode,
} from "@trebuchet/schema";
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
  return defaultTaxCategory(salesDate, { category: "revenue" }, taxSettings);
}

/** 請求税率を明示した案・入力の税区分。免税の売上は常に対象外にする。 */
export function invoiceSalesTaxCategory(
  salesDate: string,
  taxSettings: readonly TaxSettingDraft[],
  taxRate?: 8 | 10 | null | undefined,
): TaxCategoryCode {
  const defaultCategory = defaultSalesTaxCategory(salesDate, taxSettings);
  if (defaultCategory === "OUT_OF_SCOPE" || taxRate === undefined) return defaultCategory;
  return taxRate === 8 ? "SALES_8R" : taxRate === 10 ? "SALES_10" : "OUT_OF_SCOPE";
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
 * 写しに残す消費税の表示。免税でも設定した消費税相当額の別記を許す。
 */
export function effectiveTaxDisplay(
  configured: InvoiceTaxDisplay | undefined,
  _salesDate: string,
  _taxSettings: readonly TaxSettingDraft[],
): InvoiceTaxDisplay {
  return configured ?? "inclusive_only";
}
