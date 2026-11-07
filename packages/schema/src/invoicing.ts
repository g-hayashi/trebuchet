import { z } from "zod";
import { JournalOutput } from "./journals.ts";
import {
  DateString,
  DayOfMonthOrEnd,
  Id,
  MonthString,
  TaxCategoryCode,
  YEN_LIMIT,
  Yen,
} from "./primitives.ts";

// 005-recurring-invoicing（contracts/http-api.md §2〜§4、§6）
// 工数・数量の入出力は時間の数値（0.5 の倍数）。保存は半時間の整数（research R7）

const Text = z.string().max(500);
const Timestamp = z.string().min(1);

/** 0.5 の倍数か（`1.25` は不可）。工数・数量の半単位の検査の正本 */
export const isHalfStep = (n: number) => Number.isInteger(n * 2);

/** 1 明細の金額 = `floor(数量（半単位の整数）× 単価 / 2)`（data-model §1.5、INV-37）。金額の式の正本 */
export function itemAmountOfHalves(quantityHalves: number, unitPrice: number): number {
  return Math.floor((quantityHalves * unitPrice) / 2);
}

/** 1 明細の金額 = `floor(数量 × 単価)`（数量は 0.5 の倍数。data-model §1.5、INV-37） */
export function itemAmountOf(quantity: number, unitPrice: number): number {
  return itemAmountOfHalves(quantity * 2, unitPrice);
}

export const MAX_INVOICE_ITEMS = 5;

export const InvoiceTaxDisplay = z.enum(["separate", "inclusive_only"]);
export type InvoiceTaxDisplay = z.infer<typeof InvoiceTaxDisplay>;

export const InvoicePriceMode = z.enum(["inclusive", "exclusive"]);
export type InvoicePriceMode = z.infer<typeof InvoicePriceMode>;
const InvoiceTaxRate = z.union([z.literal(10), z.literal(8)]).nullable();

/** 適格請求書発行事業者の登録番号（`T` ＋ 13 桁） */
export const RegistrationNumber = z.string().regex(/^T\d{13}$/, "登録番号は T と 13 桁の数字です");

// ---- 発行者の設定（§2.1・§2.2） ----

/**
 * PUT /invoice-settings。必須の項目は空でも保存できる（発行の時点で `INVOICE_ISSUER_INCOMPLETE` になる。
 * data-model §1.1）
 */
export const InvoiceSettingsInput = z.object({
  issuerName: Text,
  tradeName: Text.optional(),
  address: Text,
  contact: Text,
  bankAccount: z.string().max(1000),
  registrationNumber: RegistrationNumber.optional(),
  taxDisplay: InvoiceTaxDisplay,
  nextSeq: z.number().int().min(1),
});
export type InvoiceSettingsInput = z.infer<typeof InvoiceSettingsInput>;

export const InvoiceSettings = z.object({
  issuerName: z.string(),
  tradeName: z.string().nullable(),
  address: z.string(),
  contact: z.string(),
  bankAccount: z.string(),
  registrationNumber: z.string().nullable(),
  taxDisplay: InvoiceTaxDisplay,
  nextSeq: z.number().int().min(1),
  updatedAt: Timestamp,
});
export type InvoiceSettings = z.infer<typeof InvoiceSettings>;

export const InvoiceSettingsResponse = z.object({
  settings: InvoiceSettings.nullable(),
  minimumNextSeq: z.number().int().min(1),
});
export type InvoiceSettingsResponse = z.infer<typeof InvoiceSettingsResponse>;

// ---- 請求の条件（§2.3〜§2.5） ----

/** 請求の種別。db の列の enum もここから導出する（正本） */
export const BILLING_TYPES = ["hourly", "monthly"] as const;
export const BillingType = z.enum(BILLING_TYPES);
export type BillingType = z.infer<typeof BillingType>;

const BillingTermsFields = z.object({
  billingType: BillingType,
  priceMode: InvoicePriceMode.optional(),
  taxRate: InvoiceTaxRate.optional(),
  unitPrice: Yen.optional(),
  monthlyAmount: Yen.optional(),
  dueMonthsAfter: z.number().int().min(0).max(12),
  dueDay: DayOfMonthOrEnd,
  defaultItemName: z.string().min(1, "既定の品名を入力してください").max(200),
  billingName: z.string().min(1).max(200).optional(),
  /** 源泉徴収あり（013）。発行時に源泉徴収税額を計算する。既定は「なし」 */
  withholding: z.boolean().default(false),
});

/** PUT /partners/:partnerId/billing-terms。型に合わない金額は拒否（`hourly` は単価だけ、`monthly` は月額だけ） */
export const BillingTermsInput = BillingTermsFields.superRefine((v, ctx) => {
  if (v.billingType === "hourly") {
    if (v.unitPrice === undefined) {
      ctx.addIssue({ code: "custom", path: ["unitPrice"], message: "単価を入力してください" });
    }
    if (v.monthlyAmount !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["monthlyAmount"],
        message: "時間単価型では月額を指定できません",
      });
    }
  } else {
    if (v.monthlyAmount === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["monthlyAmount"],
        message: "月額を入力してください",
      });
    }
    if (v.unitPrice !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["unitPrice"],
        message: "月額型では単価を指定できません",
      });
    }
  }
});
export type BillingTermsInput = z.infer<typeof BillingTermsInput>;

export const BillingTerms = z.object({
  partnerId: Id,
  billingType: BillingType,
  priceMode: InvoicePriceMode.optional(),
  taxRate: InvoiceTaxRate.optional(),
  unitPrice: z.number().int().positive().nullable(),
  monthlyAmount: z.number().int().positive().nullable(),
  dueMonthsAfter: z.number().int().min(0).max(12),
  dueDay: DayOfMonthOrEnd,
  defaultItemName: z.string(),
  billingName: z.string().nullable(),
  withholding: z.boolean(),
  updatedAt: Timestamp,
});
export type BillingTerms = z.infer<typeof BillingTerms>;

export const BillingTermsView = BillingTerms.extend({
  partnerName: z.string(),
  honorific: z.enum(["様", "御中"]).nullable(),
  partnerActive: z.boolean(),
});
export type BillingTermsView = z.infer<typeof BillingTermsView>;

export const BillingTermsListResponse = z.object({ terms: z.array(BillingTermsView) });
export type BillingTermsListResponse = z.infer<typeof BillingTermsListResponse>;

export const BillingTermsResponse = z.object({ terms: BillingTerms });
export type BillingTermsResponse = z.infer<typeof BillingTermsResponse>;

// ---- 工数（§3.1・§3.2） ----

/** 時間。0 以上の 0.5 の倍数 */
export const Hours = z.number().min(0).refine(isHalfStep, "工数は 0.5 時間単位で入力してください");

export const WorkHoursQuery = z.object({ month: MonthString });
export type WorkHoursQuery = z.infer<typeof WorkHoursQuery>;

export const WorkHoursEntryInput = z.object({ partnerId: Id, hours: Hours });
export type WorkHoursEntryInput = z.infer<typeof WorkHoursEntryInput>;

/** PUT /work-hours/:month */
export const WorkHoursInput = z.object({ entries: z.array(WorkHoursEntryInput) });
export type WorkHoursInput = z.infer<typeof WorkHoursInput>;

/** 未入力は `hours: null` */
export const WorkHoursEntry = z.object({ partnerId: Id, hours: Hours.nullable() });
export type WorkHoursEntry = z.infer<typeof WorkHoursEntry>;

export const WorkHoursResponse = z.object({ entries: z.array(WorkHoursEntry) });
export type WorkHoursResponse = z.infer<typeof WorkHoursResponse>;

// ---- 請求書の案と発行（§3.3・§3.4） ----

/** POST /invoices/drafts */
export const InvoiceDraftRequest = z.object({
  month: MonthString,
  partnerIds: z.array(Id).optional(),
});
export type InvoiceDraftRequest = z.infer<typeof InvoiceDraftRequest>;

const InvoiceItemFields = z.object({
  name: z.string().min(1, "品名を入力してください").max(200),
  quantity: z
    .number()
    .positive()
    .refine(isHalfStep, "数量は 0.5 単位で入力してください")
    .optional(),
  unit: z.string().max(20).optional(),
  unitPrice: Yen.optional(),
  amount: Yen,
  taxCategory: TaxCategoryCode.optional(),
  taxRate: InvoiceTaxRate.optional(),
});

/** 数量と単価があるとき、金額は `floor(数量 × 単価)` と一致する */
const amountMatches = (v: {
  quantity?: number | undefined;
  unitPrice?: number | undefined;
  amount: number;
}) =>
  v.quantity === undefined ||
  v.unitPrice === undefined ||
  v.amount === itemAmountOf(v.quantity, v.unitPrice);

export const InvoiceItemInput = InvoiceItemFields.refine(amountMatches, {
  message: "金額が数量 × 単価と一致しません",
  path: ["amount"],
});
export type InvoiceItemInput = z.infer<typeof InvoiceItemInput>;

/** POST /invoices。`issueDate` の既定は今日、`salesDate` は対象月の末日 */
export const InvoiceInput = z.object({
  partnerId: Id,
  priceMode: InvoicePriceMode.optional(),
  targetMonth: MonthString,
  issueDate: DateString.optional(),
  salesDate: DateString.optional(),
  items: z
    .array(InvoiceItemInput)
    .min(1, "明細を1行以上入力してください")
    .max(MAX_INVOICE_ITEMS, `明細は${MAX_INVOICE_ITEMS}行までです`),
  confirmDuplicate: z.boolean().optional(),
});
export type InvoiceInput = z.infer<typeof InvoiceInput>;

export const InvoiceItemView = z.object({
  lineNo: z.number().int().min(1).max(MAX_INVOICE_ITEMS),
  name: z.string(),
  quantity: z.number().positive().nullable(),
  unit: z.string().nullable(),
  unitPrice: z.number().int().positive().nullable(),
  amount: Yen,
  taxCategory: TaxCategoryCode,
  taxRate: z.number().int().nullable(),
});
export type InvoiceItemView = z.infer<typeof InvoiceItemView>;

/** 税率ごとの別記（税込 = 税抜 + 税額） */
export const TaxBreakdownEntry = z.object({
  rate: z.number().int(),
  inclusive: z.number().int().nonnegative(),
  tax: z.number().int().nonnegative(),
  exclusive: z.number().int().nonnegative(),
});
export type TaxBreakdownEntry = z.infer<typeof TaxBreakdownEntry>;

export const InvoiceCalculationInput = z.object({
  priceMode: InvoicePriceMode,
  items: z
    .array(z.object({ amount: Yen, taxRate: InvoiceTaxRate }))
    .min(1)
    .max(MAX_INVOICE_ITEMS),
  /** 取引先の源泉徴収の設定を引く（013）。省略は源泉徴収なし */
  partnerId: Id.optional(),
  /** 源泉徴収の税制の値を引く日。省略は今日 */
  issueDate: DateString.optional(),
});
export type InvoiceCalculationInput = z.infer<typeof InvoiceCalculationInput>;

/** 源泉徴収（013）。`withholdingBase` が 0 なら源泉徴収なし。`netAmount = total − withholdingTax` */
const WithholdingAmounts = {
  withholdingBase: z.number().int().nonnegative(),
  withholdingTax: z.number().int().nonnegative(),
  netAmount: Yen,
};

export const InvoiceCalculationResponse = z.object({
  subtotal: Yen,
  total: Yen,
  taxBreakdown: z.array(TaxBreakdownEntry),
  ...WithholdingAmounts,
});
export type InvoiceCalculationResponse = z.infer<typeof InvoiceCalculationResponse>;

export const InvoiceDraftWarning = z.object({
  code: z.literal("INVOICE_DUPLICATE_MONTH"),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type InvoiceDraftWarning = z.infer<typeof InvoiceDraftWarning>;

export const InvoiceDraft = z.object({
  partnerId: Id,
  priceMode: InvoicePriceMode.optional(),
  targetMonth: MonthString,
  issueDate: DateString,
  salesDate: DateString,
  dueDate: DateString,
  items: z.array(InvoiceItemInput),
  total: Yen,
  taxDisplay: InvoiceTaxDisplay,
  taxBreakdown: z.array(TaxBreakdownEntry),
  ...WithholdingAmounts,
  warnings: z.array(InvoiceDraftWarning),
});
export type InvoiceDraft = z.infer<typeof InvoiceDraft>;

export const InvoiceDraftSkipReason = z.enum(["NO_HOURS", "ZERO_HOURS"]);
export type InvoiceDraftSkipReason = z.infer<typeof InvoiceDraftSkipReason>;

export const InvoiceDraftResponse = z.object({
  drafts: z.array(InvoiceDraft),
  skipped: z.array(z.object({ partnerId: Id, reason: InvoiceDraftSkipReason })),
});
export type InvoiceDraftResponse = z.infer<typeof InvoiceDraftResponse>;

// ---- 請求書の一覧と詳細（§3.5・§3.6） ----

/** 状態は残額と取消だけで決まる（期限切れは状態ではなく判定。data-model §3） */
export const InvoiceStatus = z.enum(["unpaid", "partial", "paid", "voided"]);
export type InvoiceStatus = z.infer<typeof InvoiceStatus>;

/** 一覧の絞り込みの `status`。`overdue` は期限切れの判定が真のもの */
export const InvoiceListStatus = z.enum(["unpaid", "partial", "paid", "voided", "overdue"]);
export type InvoiceListStatus = z.infer<typeof InvoiceListStatus>;

/** GET /invoices?partnerId=&month=&status= */
export const InvoiceListQuery = z.object({
  partnerId: Id.optional(),
  month: MonthString.optional(),
  status: InvoiceListStatus.optional(),
});
export type InvoiceListQuery = z.infer<typeof InvoiceListQuery>;

export const InvoiceSummary = z.object({
  id: Id,
  invoiceNo: z.string(),
  partnerId: Id,
  recipientName: z.string(),
  targetMonth: MonthString,
  issueDate: DateString,
  dueDate: DateString,
  total: Yen,
  ...WithholdingAmounts,
  paid: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  status: InvoiceStatus,
  overdue: z.boolean(),
});
export type InvoiceSummary = z.infer<typeof InvoiceSummary>;

export const OutstandingByPartner = z.object({
  partnerId: Id,
  partnerName: z.string(),
  outstanding: z.number().int().nonnegative(),
  overdue: z.number().int().nonnegative(),
});
export type OutstandingByPartner = z.infer<typeof OutstandingByPartner>;

export const InvoiceListResponse = z.object({
  invoices: z.array(InvoiceSummary),
  outstandingByPartner: z.array(OutstandingByPartner),
});
export type InvoiceListResponse = z.infer<typeof InvoiceListResponse>;

/** 請求書に写した発行者（`issuer_json`） */
export const InvoiceIssuer = z.object({
  issuerName: z.string(),
  tradeName: z.string().nullable(),
  address: z.string(),
  contact: z.string(),
  bankAccount: z.string(),
  registrationNumber: z.string().nullable(),
});
export type InvoiceIssuer = z.infer<typeof InvoiceIssuer>;

/** §4 の `PaymentView` */
export const PaymentView = z.object({
  id: Id,
  receivedOn: DateString,
  amount: Yen,
  feeAmount: z.number().int().nonnegative(),
  /** 実際に差し引かれた源泉徴収税額（013）。0 は源泉徴収なし */
  withholdingAmount: z.number().int().nonnegative(),
  depositAccountId: Id,
  depositSubAccountId: Id.nullable(),
  journalId: Id,
  voidedAt: Timestamp.nullable(),
  voidReason: z.string().nullable(),
  voidJournalId: Id.nullable(),
});
export type PaymentView = z.infer<typeof PaymentView>;

export const InvoiceDetail = InvoiceSummary.extend({
  salesDate: DateString,
  priceMode: InvoicePriceMode.optional(),
  recipientHonorific: z.enum(["様", "御中"]),
  issuer: InvoiceIssuer,
  taxDisplay: InvoiceTaxDisplay,
  items: z.array(InvoiceItemView),
  taxBreakdown: z.array(TaxBreakdownEntry),
  journalId: Id,
  voidJournalId: Id.nullable(),
  voidedAt: Timestamp.nullable(),
  voidReason: z.string().nullable(),
  payments: z.array(PaymentView),
  /** 取消でない消し込みの源泉徴収税額の合計（013） */
  withholdingPaid: z.number().int().nonnegative(),
  /** `max(0, withholdingTax − withholdingPaid)`。消し込みの源泉徴収税額の既定値 */
  withholdingRemaining: z.number().int().nonnegative(),
});
export type InvoiceDetail = z.infer<typeof InvoiceDetail>;

/** POST /invoices の 201、POST /invoices/:invoiceId/void の 200 */
export const InvoiceWithJournalResponse = z.object({
  invoice: InvoiceDetail,
  journal: JournalOutput,
});
export type InvoiceWithJournalResponse = z.infer<typeof InvoiceWithJournalResponse>;

/**
 * 請求・入金の取消の入力（§3.7、§4.2）。001 の `VoidInput` は `version` が必須なので使わない。
 * 空欄・空白のみの判定はドメインで行い `REASON_REQUIRED` を返すため、ここでは文字列であることだけを検証する
 */
export const InvoicingVoidInput = z.object({ reason: z.string() });
export type InvoicingVoidInput = z.infer<typeof InvoicingVoidInput>;

// ---- 入金の消し込み（§4） ----

/** POST /invoices/:invoiceId/payments */
export const PaymentInput = z.object({
  receivedOn: DateString,
  amount: Yen,
  depositAccountId: Id,
  depositSubAccountId: Id.optional(),
  treatDifferenceAsFee: z.boolean().optional(),
  /** 実際に差し引かれた源泉徴収税額（013）。0 以上の整数。省略は 0 */
  withholdingAmount: z.number().int().nonnegative().lt(YEN_LIMIT).optional(),
});
export type PaymentInput = z.infer<typeof PaymentInput>;

/** POST /invoices/:invoiceId/payments の 201 */
export const PaymentRecordedResponse = z.object({
  payment: PaymentView,
  invoice: InvoiceSummary,
  journal: JournalOutput,
});
export type PaymentRecordedResponse = z.infer<typeof PaymentRecordedResponse>;

// ---- 年間の源泉徴収（013 contracts §4） ----

const Yen0 = z.number().int().nonnegative();

/** 年間の一覧の消し込み 1 件。`applied` = 入金額 + 差額 + 源泉徴収税額 */
export const WithholdingSummaryPayment = z.object({
  paymentId: Id,
  invoiceId: Id,
  invoiceNo: z.string(),
  receivedOn: DateString,
  applied: Yen0,
  withholdingAmount: Yen,
});
export type WithholdingSummaryPayment = z.infer<typeof WithholdingSummaryPayment>;

/** GET /withholding/:year の 200。取消でない源泉徴収つきの消し込みを、入金日の暦年で取引先ごとに集計する */
export const WithholdingSummary = z.object({
  year: z.number().int(),
  /** 取引先名の順。該当がなければ空 */
  partners: z.array(
    z.object({
      partnerId: Id,
      partnerName: z.string(),
      paymentCount: Yen0,
      appliedTotal: Yen0,
      withholdingTotal: Yen0,
      payments: z.array(WithholdingSummaryPayment),
    }),
  ),
  appliedTotal: Yen0,
  withholdingTotal: Yen0,
});
export type WithholdingSummary = z.infer<typeof WithholdingSummary>;

// ---- 仕訳との相互参照（§6.1） ----

export const JournalOrigin = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("invoice"), invoiceId: Id, invoiceNo: z.string() }),
  z.object({
    kind: z.literal("payment"),
    invoiceId: Id,
    invoiceNo: z.string(),
    paymentId: Id,
  }),
  z.object({
    kind: z.literal("recurring"),
    recurringId: Id,
    name: z.string(),
    targetMonth: MonthString,
  }),
]);
export type JournalOrigin = z.infer<typeof JournalOrigin>;

export const JournalOriginResponse = z.object({ origin: JournalOrigin.nullable() });
export type JournalOriginResponse = z.infer<typeof JournalOriginResponse>;
