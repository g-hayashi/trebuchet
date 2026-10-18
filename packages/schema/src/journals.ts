import { z } from "zod";
import { DateString, Id, Side, TaxCategoryCode, Yen } from "./primitives.ts";

export const JournalLineInput = z.object({
  side: Side,
  accountId: Id,
  subAccountId: Id.optional(),
  amount: Yen,
  taxCategory: TaxCategoryCode.optional(),
  partnerId: Id.optional(),
  description: z.string().max(500).optional(),
  tagIds: z
    .array(Id)
    .refine((ids) => new Set(ids).size === ids.length, "同じタグが重複しています")
    .optional(),
});
export type JournalLineInput = z.infer<typeof JournalLineInput>;

/** 行の数と借方・貸方の検証を除いた項目（訂正の入力で拡張する） */
export const JournalInputFields = z.object({
  date: DateString,
  memo: z.string().max(1000).optional(),
  correctsJournalId: Id.optional(),
  lines: z
    .array(JournalLineInput)
    .min(2, "行は2行以上入力してください")
    .max(100, "行は100行までです"),
});

const hasBothSides = (v: { lines: { side: Side }[] }) =>
  v.lines.some((l) => l.side === "debit") && v.lines.some((l) => l.side === "credit");

export const JournalInput = JournalInputFields.refine(hasBothSides, {
  message: "借方と貸方をそれぞれ1行以上入力してください",
  path: ["lines"],
});
export type JournalInput = z.infer<typeof JournalInput>;

export const JournalStatus = z.enum(["active", "voided"]);
export type JournalStatus = z.infer<typeof JournalStatus>;

export const JournalLineOutput = z.object({
  id: Id,
  lineNo: z.number().int().positive(),
  side: Side,
  accountId: Id,
  subAccountId: Id.nullable(),
  amount: Yen,
  taxCategory: TaxCategoryCode,
  taxAmount: z.number().int().nonnegative(),
  partnerId: Id.nullable(),
  description: z.string().nullable(),
  tagIds: z.array(Id),
});
export type JournalLineOutput = z.infer<typeof JournalLineOutput>;

export const JournalOutput = z.object({
  id: Id,
  journalNo: z.number().int().positive(),
  date: DateString,
  memo: z.string().nullable(),
  status: JournalStatus,
  version: z.number().int().positive(),
  correctsJournalId: Id.nullable(),
  lines: z.array(JournalLineOutput),
});
export type JournalOutput = z.infer<typeof JournalOutput>;

/** GET /journals のクエリ（US2 は件数だけ。検索の条件は US3 で加える） */
export const JournalListQuery = z.object({
  limit: z
    .string()
    .regex(/^\d+$/, "件数は整数で指定してください")
    .transform(Number)
    .pipe(z.number().int().min(1).max(200))
    .optional(),
});
export type JournalListQuery = z.infer<typeof JournalListQuery>;
