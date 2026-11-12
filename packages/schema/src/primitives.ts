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

/** 月（`YYYY-MM`。月は 01〜12） */
export const MonthString = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "月は YYYY-MM で入力してください");

/** 年（4 桁の数字） */
export const YEAR_PATTERN = /^\d{4}$/;

/** パスの `:year`（4 桁の数字）。数値にする。形が違うときの応答は server の `validate` が決める */
export const FiscalYearParam = z.object({
  year: z.string().regex(YEAR_PATTERN).transform(Number),
});

/** SHA-256（小文字16進64文字）の形 */
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** ファイルの内容の SHA-256（小文字16進64文字） */
export const Sha256 = z.string().regex(SHA256_PATTERN, "SHA-256 の形式が正しくありません");

/** 確信度・しきい値（0〜100 の整数） */
export const Percent = z.number().int().min(0).max(100);

// API のクエリ文字列（すべて文字列）と、TanStack Router の URL の検索パラメータ
// （数値・真偽値は JSON として解釈される）の両方を受け付ける

export const QueryInt = z.union([
  z.number(),
  z.string().regex(/^\d+$/, "整数で指定してください").transform(Number),
]);
/** URL の検索パラメーターは数字だけの値を数値に読むので、文字列に戻す（取引先が「7」のとき） */
export const QueryText = z.union([z.string(), z.number().transform(String)]);
export const QueryBool = z.union([
  z.boolean(),
  z.enum(["true", "false"]).transform((v) => v === "true"),
]);
/** 金額の検索の範囲（0 以上 1 兆円未満の整数） */
export const AmountBound = QueryInt.pipe(z.number().int().nonnegative().lt(YEN_LIMIT));

/** 日（1〜28、または 31 = 末日。29・30 は不可。005 の R8） */
export const DayOfMonthOrEnd = z
  .number()
  .int()
  .refine((d) => (d >= 1 && d <= 28) || d === 31, "日は 1〜28 または末日（31）にしてください");

export const Id = z.uuid();

/** 貸借（db の列の `enum` もこの定数から作る） */
export const SIDES = ["debit", "credit"] as const;
export const Side = z.enum(SIDES);
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

/** 科目の区分ごとに選べる決算書の区分（先頭が既定。web の選択肢と domain の usecases/masters.ts の検査に使う） */
export const ALLOWED_SECTIONS: Record<AccountCategory, readonly ReportSection[]> = {
  asset: ["BS_ASSET"],
  liability: ["BS_LIABILITY"],
  equity: ["BS_EQUITY", "BS_ASSET"],
  revenue: ["PL_SALES", "PL_OTHER"],
  expense: ["PL_COGS", "PL_EXPENSE", "PL_OTHER"],
};

/** 事業体の種別（db の列の `enum` もこの定数から作る） */
export const ENTITY_KINDS = ["individual", "corporation"] as const;
export const EntityKind = z.enum(ENTITY_KINDS);
export type EntityKind = z.infer<typeof EntityKind>;

export const TaxpayerStatus = z.enum(["exempt", "general", "simplified", "two_tenths"]);
export type TaxpayerStatus = z.infer<typeof TaxpayerStatus>;

export const AccountingMethod = z.enum(["tax_included", "tax_excluded"]);
export type AccountingMethod = z.infer<typeof AccountingMethod>;
