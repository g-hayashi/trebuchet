import type {
  BillingTerms,
  InvoiceDraft,
  InvoiceDraftSkipReason,
  InvoiceItemInput,
  InvoiceSettings,
} from "@trebuchet/schema";
import type { JournalContext } from "../journal.ts";
import type { InvoiceRecord, Partner } from "../types.ts";
import { itemAmount } from "./amounts.ts";
import { dueDate, monthEnd } from "./due-date.ts";
import {
  defaultSalesTaxCategory,
  effectiveTaxDisplay,
  itemTaxRate,
  taxBreakdownEntries,
} from "./tax.ts";

export type DraftOutcome =
  | { kind: "draft"; draft: InvoiceDraft }
  | { kind: "skipped"; reason: InvoiceDraftSkipReason };

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
};

/**
 * 請求書の案を作る（R3: 保存しない）。時間単価型は工数 × 単価の 1 行（品名 `{M}月分 {既定の品名}`、
 * 数量 = 工数、単位 `時間`）、月額定額型は月額の 1 行。工数がない・0 の時間単価型は案を作らず `skipped`。
 * 金額は整数だけで計算する（R7）
 */
export function buildInvoiceDraft(input: BuildInvoiceDraftInput): DraftOutcome {
  const { terms, month, today, ctx } = input;
  const salesDate = monthEnd(month);
  const taxCategory = defaultSalesTaxCategory(salesDate, ctx.taxSettings);
  const name = `${Number(month.slice(5))}月分 ${terms.defaultItemName}`;

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

  const taxRate = itemTaxRate(taxCategory, salesDate, ctx.taxSettings, ctx.taxRates);
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
      targetMonth: month,
      issueDate: today,
      salesDate,
      dueDate: dueDate(month, terms.dueMonthsAfter, terms.dueDay),
      items: [item],
      total: item.amount,
      taxDisplay: effectiveTaxDisplay(input.settings?.taxDisplay, salesDate, ctx.taxSettings),
      taxBreakdown: taxBreakdownEntries([{ amount: item.amount, taxRate }]),
      warnings,
    },
  };
}
