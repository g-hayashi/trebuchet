import type {
  BillingTerms,
  InvoiceDraft,
  InvoiceDraftSkipReason,
  InvoiceItemInput,
  InvoiceSettings,
} from "@trebuchet/schema";
import { monthEnd, monthNumberOf } from "../dates.ts";
import type { JournalContext } from "../journal.ts";
import type { DomainError, InvoiceRecord, Partner, TaxParameter } from "../types.ts";
import { calculateInvoiceAmounts, itemAmount } from "./amounts.ts";
import { dueDate } from "./due-date.ts";
import { effectiveTaxDisplay, invoiceSalesTaxCategory, itemTaxRate } from "./tax.ts";
import { invoiceWithholding } from "./withholding.ts";

export type DraftOutcome =
  | { kind: "draft"; draft: InvoiceDraft }
  | { kind: "skipped"; reason: InvoiceDraftSkipReason }
  /** 源泉徴収の税制の値が発行日にない（`WITHHOLDING_RATE_MISSING`。013） */
  | { kind: "error"; error: DomainError };

export type BuildInvoiceDraftInput = {
  terms: BillingTerms;
  partner: Pick<Partner, "id" | "name">;
  /** 対象月の工数（半時間の整数）。入力がなければ null。月額定額型では使わない */
  halfHours: number | null;
  /** 対象月（`YYYY-MM`） */
  month: string;
  /** 発行者の設定。なければ（まだ設定していない）税込のみで案を作る */
  settings: Pick<InvoiceSettings, "taxDisplay"> | null;
  /** 今日（`YYYY-MM-DD`）。発行日の既定 */
  today: string;
  /** 同じ取引先・対象月の取消でない請求書（重複の警告に使う。FR-016） */
  activeInvoices: readonly Pick<InvoiceRecord, "invoiceNo">[];
  ctx: Pick<JournalContext, "taxSettings" | "taxRates">;
  /** 税制の値。源泉徴収あり（`terms.withholding`）の取引先の案でだけ使う（013）。省略は空 */
  taxParameters?: readonly TaxParameter[] | undefined;
};

/**
 * 請求書の案を作る（R3: 保存しない）。時間単価型は工数 × 単価の 1 行（品名 `{M}月分 {既定の品名}`、
 * 数量 = 工数、単位 `時間`）、月額定額型は月額の 1 行。工数がない・0 の時間単価型は案を作らず `skipped`。
 * 金額は整数だけで計算する（R7）
 */
export function buildInvoiceDraft(input: BuildInvoiceDraftInput): DraftOutcome {
  const { terms, month, today, ctx } = input;
  const salesDate = monthEnd(month);
  const taxCategory = invoiceSalesTaxCategory(salesDate, ctx.taxSettings, terms.taxRate);
  const name = `${monthNumberOf(month)}月分 ${terms.defaultItemName}`;

  let item: InvoiceItemInput;
  if (terms.billingType === "hourly") {
    if (input.halfHours === null) return { kind: "skipped", reason: "NO_HOURS" };
    if (input.halfHours === 0) return { kind: "skipped", reason: "ZERO_HOURS" };
    const unitPrice = terms.unitPrice ?? 0;
    item = {
      name,
      quantity: input.halfHours / 2,
      unit: "時間",
      unitPrice,
      amount: itemAmount(input.halfHours, unitPrice),
      taxCategory,
    };
  } else {
    item = { name, amount: terms.monthlyAmount ?? 0, taxCategory };
  }

  const taxRate =
    terms.taxRate === undefined
      ? itemTaxRate(taxCategory, salesDate, ctx.taxSettings, ctx.taxRates)
      : terms.taxRate;
  // 過去の税率は既存の導出経路に任せる。新たに明示できる税率は 8/10/null。
  if (taxRate === null || taxRate === 8 || taxRate === 10) item.taxRate = taxRate;
  const priceMode = terms.priceMode ?? "inclusive";
  const amounts = calculateInvoiceAmounts([{ amount: item.amount, taxRate }], priceMode);
  const taxDisplay = effectiveTaxDisplay(input.settings?.taxDisplay);
  const withholding = invoiceWithholding({
    enabled: terms.withholding,
    amounts,
    taxDisplay,
    date: today,
    params: input.taxParameters ?? [],
  });
  if (!withholding.ok) return { kind: "error", error: withholding.error };
  const warnings: InvoiceDraft["warnings"] =
    input.activeInvoices.length === 0
      ? []
      : [
          {
            code: "INVOICE_DUPLICATE_MONTH",
            message: `${input.partner.name} の ${month} 分の請求書がすでにあります（${input.activeInvoices
              .map((i) => i.invoiceNo)
              .join("、")}）`,
            details: { invoices: input.activeInvoices.map((i) => i.invoiceNo) },
          },
        ];

  return {
    kind: "draft",
    draft: {
      partnerId: input.partner.id,
      priceMode,
      targetMonth: month,
      issueDate: today,
      salesDate,
      dueDate: dueDate(month, terms.dueMonthsAfter, terms.dueDay),
      items: [item],
      total: amounts.total,
      taxDisplay,
      taxBreakdown: amounts.taxBreakdown,
      ...withholding.value,
      warnings,
    },
  };
}
