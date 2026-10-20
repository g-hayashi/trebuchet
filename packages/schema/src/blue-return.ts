import { z } from "zod";
import { ErrorDetails } from "./errors.ts";
import { JournalInput } from "./journals.ts";
import { DateString, Id } from "./primitives.ts";

// 003-tax-return（contracts/http-api.md、data-model.md §1・§2）

/** 割合は万分率の整数（0〜10000） */
const Ratio = z.number().int().min(0).max(10000);
/** 0 以上の整数の円 */
const NonNegativeYen = z.number().int().nonnegative();
/** 帳票の金額（符号付きの整数） */
const Amount = z.number().int();
const FiscalYear = z.number().int().min(1900).max(9999);
const NonEmpty = z.string().trim().min(1, "入力してください").max(500);
const Memo = z.string().max(1000);
/** `/` で始まる絶対パス（research R13。相対パスはサーバーの作業ディレクトリに依存するため拒否する） */
const AbsolutePath = z
  .string()
  .max(1000)
  .refine((v) => v.startsWith("/"), "絶対パス（/ で始まる）を入力してください");

// ---- 入力 ----

/** 決算書の CSV のクエリ（GET /blue-return/:year/csv）。`blankUnused=true` で使わない欄を空にする（R14） */
export const BlueReturnCsvQuery = z.object({
  blankUnused: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});
export type BlueReturnCsvQuery = z.infer<typeof BlueReturnCsvQuery>;

/** 家事按分の登録（PUT /blue-return/:year/home-use） */
export const HomeUseAllocationInput = z.object({
  accountId: Id,
  subAccountId: Id.nullish(),
  businessRatio: Ratio,
  basis: z.string().trim().min(1, "根拠を入力してください").max(1000),
  changeReason: z.string().max(1000).nullish(),
});
export type HomeUseAllocationInput = z.infer<typeof HomeUseAllocationInput>;

/** 地代家賃の内訳の1行（PUT /blue-return/:year/rent-details の rows） */
export const RentDetailInput = z
  .object({
    payee: NonEmpty,
    property: NonEmpty,
    annualRent: NonNegativeYen,
    deductibleAmount: NonNegativeYen,
  })
  .refine((v) => v.deductibleAmount <= v.annualRent, {
    message: "必要経費算入額は賃借料以下にしてください",
    path: ["deductibleAmount"],
  });
export type RentDetailInput = z.infer<typeof RentDetailInput>;

export const DepreciationMethod = z.enum(["small_asset_28_2"]);
export type DepreciationMethod = z.infer<typeof DepreciationMethod>;

/** 固定資産の登録（POST /fixed-assets）。方法は少額の特例だけ（R7） */
export const FixedAssetInput = z.object({
  name: NonEmpty,
  quantity: z.string().max(100).nullish(),
  acquiredOn: DateString,
  acquisitionCost: z.number().int().positive(),
  method: DepreciationMethod,
  usefulLifeYears: z.number().int().positive().nullish(),
  businessRatio: Ratio,
  assetAccountId: Id,
  linkedJournalId: Id.nullish(),
  note: z.string().max(1000).nullish(),
});
export type FixedAssetInput = z.infer<typeof FixedAssetInput>;

/** 青色申告特別控除の要件の回答（PUT /blue-return/:year/deduction-answers） */
export const DeductionAnswersInput = z.object({
  doubleEntry: z.boolean(),
  statementsAttached: z.boolean(),
  filedOnTime: z.boolean(),
  eTax: z.boolean(),
  electronicBooks: z.boolean(),
});
export type DeductionAnswersInput = z.infer<typeof DeductionAnswersInput>;

export const ClosingNoteKind = z.enum(["special_circumstances", "opening_difference"]);
export type ClosingNoteKind = z.infer<typeof ClosingNoteKind>;

export const ClosingNoteInput = z.object({ body: z.string().max(5000) });
export type ClosingNoteInput = z.infer<typeof ClosingNoteInput>;

export const TaxReturnMemoKind = z.enum([
  "salary",
  "social_insurance",
  "small_business_mutual_aid",
  "life_insurance",
  "earthquake_insurance",
  "donation",
  "medical",
  "stocks",
  "crypto",
  "foreign_tax_credit",
  "other",
]);
export type TaxReturnMemoKind = z.infer<typeof TaxReturnMemoKind>;

/** 事業所得以外の控え（POST /tax-return/:year/memos） */
export const TaxReturnMemoInput = z
  .object({
    kind: TaxReturnMemoKind,
    label: z.string().max(200).nullish(),
    amount: NonNegativeYen.nullish(),
    filePath: AbsolutePath.nullish(),
    memo: Memo.nullish(),
  })
  .refine((v) => v.kind !== "other" || (v.label != null && v.label.trim() !== ""), {
    message: "「その他」のときは項目名を入力してください",
    path: ["label"],
  });
export type TaxReturnMemoInput = z.infer<typeof TaxReturnMemoInput>;

export const FiledDocumentKind = z.enum(["blue_return", "tax_return", "attachment", "other"]);
export type FiledDocumentKind = z.infer<typeof FiledDocumentKind>;

/** 提出書類の記録（POST /tax-return/:year/documents） */
export const FiledDocumentInput = z.object({
  kind: FiledDocumentKind,
  filePath: AbsolutePath,
  filedOn: DateString.nullish(),
  memo: Memo.nullish(),
});
export type FiledDocumentInput = z.infer<typeof FiledDocumentInput>;

// ---- 出力 ----

/** data-model §2 の14種 */
export const BlueReturnWarningCode = z.enum([
  "OPTIONAL_LINES_OVERFLOW",
  "PL_MISMATCH",
  "HOME_USE_ADJUSTMENT_STALE",
  "RENT_DETAILS_MISMATCH",
  "DEPRECIATION_MISMATCH",
  "SALES_TOTAL_MISMATCH",
  "SALES_WITHOUT_PARTNER",
  "DUPLICATE_PARTNER_NAME",
  "OPENING_MISMATCH",
  "DEFERRED_ASSET_NOT_AMORTIZED",
  "OPENING_OWNER_ACCOUNTS",
  "NEGATIVE_BALANCE",
  "DEDUCTION_ANSWERS_MISSING",
  "PRIOR_PERIOD_OPEN",
]);
export type BlueReturnWarningCode = z.infer<typeof BlueReturnWarningCode>;

export const BlueReturnWarning = z.object({
  code: BlueReturnWarningCode,
  message: z.string(),
  details: ErrorDetails.optional(),
});
export type BlueReturnWarning = z.infer<typeof BlueReturnWarning>;

export const AdjustmentKind = z.enum(["home_use", "depreciation"]);
export type AdjustmentKind = z.infer<typeof AdjustmentKind>;

const HomeUseBreakdown = z.object({
  bookAmount: Amount,
  ratio: Ratio,
  business: NonNegativeYen,
  home: NonNegativeYen,
});

const DepreciationBreakdown = z.object({
  acquisitionCost: z.number().int().positive(),
  businessRatio: Ratio,
  deductible: NonNegativeYen,
});

/** 決算整理の仕訳の案。journal は年度末日付で、登録するときは 001 の仕訳の入力と同じ */
export const AdjustmentProposal = z.object({
  kind: AdjustmentKind,
  /** 按分の登録 ID または資産 ID */
  sourceId: Id,
  journal: JournalInput,
  breakdown: z.union([HomeUseBreakdown, DepreciationBreakdown]),
});
export type AdjustmentProposal = z.infer<typeof AdjustmentProposal>;

/** 1ページの欄の種類（様式の定義）。unused は使わない欄で、空欄の表示と CSV の対象 */
export const FormLineKind = z.enum(["account", "optional", "computed", "unused"]);
export type FormLineKind = z.infer<typeof FormLineKind>;

const FormLineAmount = z.object({
  no: z.number().int().positive(),
  label: z.string(),
  /** 空欄（回答待ちなど）は null */
  amount: Amount.nullable(),
  kind: FormLineKind,
});

const MonthlyRow = z.object({
  month: z.number().int().min(1).max(12),
  sales: Amount,
  otherIncome: Amount,
  total: Amount,
});

const RentDetailRow = z.object({
  payee: z.string(),
  property: z.string(),
  annualRent: NonNegativeYen,
  deductibleAmount: NonNegativeYen,
});

const DeductionOutput = z.object({
  cap: NonNegativeYen,
  tier: z.enum(["max", "standard", "basic"]),
  unmet: z.array(z.string()),
  amount: NonNegativeYen,
});

const SalesPartnerRow = z.object({
  partnerId: Id.nullish(),
  name: z.string(),
  amount: Amount,
});

const DepreciationRow = z.object({
  assetId: Id,
  name: z.string(),
  quantity: z.string().nullable(),
  acquiredOn: DateString,
  cost: z.number().int().positive(),
  method: DepreciationMethod,
  usefulLifeYears: z.number().int().positive().nullable(),
  base: Amount,
  ordinary: Amount,
  total: Amount,
  businessRatio: Ratio,
  deductible: Amount,
  closingBookValue: Amount,
  note: z.string().nullable(),
});

const BsRowOutput = z.object({ label: z.string(), amount: Amount.nullable() });
const BsSideOutput = z.object({ rows: z.array(BsRowOutput), total: Amount });
const BsOutput = z.object({ assets: BsSideOutput, liabilityEquity: BsSideOutput });

/** 青色申告決算書（一般用）。使わない欄は常に 0、空欄の表示は画面が行う（R14） */
export const BlueReturn = z.object({
  fiscalYear: FiscalYear,
  /** 使った様式の年分（R2） */
  formYear: FiscalYear,
  status: z.enum(["open", "closed"]),
  page1: z.object({ lines: z.array(FormLineAmount) }),
  page2: z.object({
    monthly: z.object({
      months: z.array(MonthlyRow),
      total: z.object({ sales: Amount, otherIncome: Amount, total: Amount }),
    }),
    rentDetails: z.array(RentDetailRow),
    /** 回答がないときは null（FR-010） */
    deduction: DeductionOutput.nullable(),
  }),
  page3: z.object({
    salesPartners: z.object({
      rows: z.array(SalesPartnerRow),
      others: Amount,
      withoutPartner: z.object({ count: NonNegativeYen, amount: Amount }).nullable(),
    }),
    depreciation: z.array(DepreciationRow),
  }),
  page4: z.object({ opening: BsOutput, closing: BsOutput }),
  /** 欄45（所得金額）と欄44（控除額）。回答がなければ null */
  transfer: z.object({ businessIncome: Amount.nullable(), blueDeduction: Amount.nullable() }),
  warnings: z.array(BlueReturnWarning),
});
export type BlueReturn = z.infer<typeof BlueReturn>;
