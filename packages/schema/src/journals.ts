import { z } from "zod";
import { DateString, Id, Side, TaxCategoryCode, YEN_LIMIT, Yen } from "./primitives.ts";

/** 仕訳の出どころ。domain の型と db の列の enum はここから導出する（正本） */
export const JOURNAL_SOURCES = [
  "manual",
  "import_freee",
  "invoice",
  "payment",
  "recurring",
  "statement",
] as const;
export const JournalSource = z.enum(JOURNAL_SOURCES);
export type JournalSource = z.infer<typeof JournalSource>;

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

/**
 * 訂正の理由など。空欄・空白のみ・500 文字超の判定はドメインで行い REASON_REQUIRED を返すため、
 * ここでは文字列であることだけを検証する（contracts/http-api.md）
 */
const Reason = z.string();
const Version = z.number().int().positive();

/** PUT /journals/:id（FR-019, FR-020） */
export const JournalCorrection = JournalInputFields.extend({
  reason: Reason,
  version: Version,
}).refine(hasBothSides, {
  message: "借方と貸方をそれぞれ1行以上入力してください",
  path: ["lines"],
});
export type JournalCorrection = z.infer<typeof JournalCorrection>;

/** POST /journals/:id/void（FR-019, FR-021） */
export const VoidInput = z.object({ reason: Reason, version: Version });
export type VoidInput = z.infer<typeof VoidInput>;

/** POST /fiscal-periods/:year/reopen（FR-024, FR-025） */
export const ReopenInput = z.object({ reason: Reason });
export type ReopenInput = z.infer<typeof ReopenInput>;

// ---- 検索（FR-023） ----
// API のクエリ文字列（すべて文字列）と、TanStack Router の URL の検索パラメータ
// （数値・真偽値は JSON として解釈される）の両方を受け付ける

const QueryInt = z.union([
  z.number(),
  z.string().regex(/^\d+$/, "整数で指定してください").transform(Number),
]);
const QueryText = z.union([z.string(), z.number().transform(String)]);
const QueryBool = z.union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")]);
const AmountBound = QueryInt.pipe(z.number().int().nonnegative().lt(YEN_LIMIT));

/** 検索のカーソル。直前のページの最後の仕訳の「日付_仕訳番号」 */
export const JournalCursor = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}_\d+$/, "カーソルの形式が正しくありません");

export const DEFAULT_JOURNAL_LIMIT = 50;

/**
 * GET /journals の検索条件。結果は日付の降順、同じ日付は仕訳番号の降順。
 * 金額の範囲は、いずれかの行の金額が範囲に入れば一致。q は摘要・メモの部分一致
 */
export const JournalQuery = z.object({
  dateFrom: DateString.optional(),
  dateTo: DateString.optional(),
  amountMin: AmountBound.optional(),
  amountMax: AmountBound.optional(),
  partnerId: Id.optional(),
  accountId: Id.optional(),
  q: QueryText.pipe(z.string().max(200)).optional(),
  tagId: Id.optional(),
  includeVoided: QueryBool.default(false),
  cursor: JournalCursor.optional(),
  limit: QueryInt.pipe(z.number().int().min(1).max(200)).default(DEFAULT_JOURNAL_LIMIT),
});
export type JournalQuery = z.infer<typeof JournalQuery>;
export type JournalQueryInput = z.input<typeof JournalQuery>;

/** 訂正元・訂正仕訳への参照（FR-019a） */
export const JournalRef = z.object({
  id: Id,
  journalNo: z.number().int().positive(),
  date: DateString,
  status: JournalStatus,
});
export type JournalRef = z.infer<typeof JournalRef>;

export const HistoryAction = z.enum(["create", "correct", "void"]);

/** GET /journals/:id/history の1項目（FR-020, SC-005）。before・after は仕訳の全内容 */
export const HistoryEntry = z.object({
  occurredAt: z.string(),
  action: HistoryAction,
  reason: z.string().nullable(),
  before: JournalOutput.nullable(),
  after: JournalOutput.nullable(),
});
export type HistoryEntry = z.infer<typeof HistoryEntry>;
