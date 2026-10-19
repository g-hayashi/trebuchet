import { z } from "zod";

export const YEN_LIMIT = 1_000_000_000_000;

/** 円。正の整数で 1 兆円未満（INV-3） */
export const Yen = z.number().int().positive().lt(YEN_LIMIT);

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` で、実在する日付か */
export function isValidDateString(value: string): boolean {
  const m = DATE_PATTERN.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

export const DateString = z
  .string()
  .regex(DATE_PATTERN, "日付は YYYY-MM-DD で入力してください")
  .refine(isValidDateString, "存在しない日付です");

export const Id = z.uuid();

export const Side = z.enum(["debit", "credit"]);
export type Side = z.infer<typeof Side>;

export const TaxCategoryCode = z.enum([
  "OUT_OF_SCOPE",
  "SALES_10",
  "SALES_8R",
  "PURCHASE_10",
  "PURCHASE_8R",
  "EXEMPT",
  "NON_TAXABLE",
]);
export type TaxCategoryCode = z.infer<typeof TaxCategoryCode>;

export const AccountCategory = z.enum(["asset", "liability", "equity", "revenue", "expense"]);
export type AccountCategory = z.infer<typeof AccountCategory>;

export const ReportSection = z.enum([
  "PL_SALES",
  "PL_COGS",
  "PL_EXPENSE",
  "PL_OTHER",
  "BS_ASSET",
  "BS_LIABILITY",
  "BS_EQUITY",
]);
export type ReportSection = z.infer<typeof ReportSection>;

export const EntityKind = z.enum(["individual", "corporation"]);
export type EntityKind = z.infer<typeof EntityKind>;

export const TaxpayerStatus = z.enum(["exempt", "general", "simplified", "two_tenths"]);
export type TaxpayerStatus = z.infer<typeof TaxpayerStatus>;

export const AccountingMethod = z.enum(["tax_included", "tax_excluded"]);
export type AccountingMethod = z.infer<typeof AccountingMethod>;
