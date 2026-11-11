import type { InvoiceDetail, InvoiceSummary, PaymentView } from "@trebuchet/schema";
import type { InvoiceItemRecord, InvoiceRecord, PaymentRecord } from "../types.ts";
import { calculateInvoiceAmounts } from "./amounts.ts";
import { invoiceStatus, isOverdue, withholdingStanding } from "./status.ts";

/**
 * 一覧の 1 行（H:§3.5）。`today` を渡すと `overdue` を判定する（`isOverdue`）。省略すると偽
 */
export function buildInvoiceSummary(
  invoice: InvoiceRecord,
  payments: readonly PaymentRecord[],
  today?: string,
): InvoiceSummary {
  const standing = invoiceStatus(invoice, payments);
  return {
    id: invoice.id,
    invoiceNo: invoice.invoiceNo,
    partnerId: invoice.partnerId,
    recipientName: invoice.recipientName,
    targetMonth: invoice.targetMonth,
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    total: invoice.total,
    withholdingBase: invoice.withholdingBase,
    withholdingTax: invoice.withholdingTax,
    netAmount: invoice.total - invoice.withholdingTax,
    paid: standing.paid,
    remaining: standing.remaining,
    status: standing.status,
    overdue: today === undefined ? false : isOverdue(invoice, standing.remaining, today),
  };
}

export const toPaymentView = (p: PaymentRecord): PaymentView => ({
  id: p.id,
  receivedOn: p.receivedOn,
  amount: p.amount,
  feeAmount: p.feeAmount,
  withholdingAmount: p.withholdingAmount,
  depositAccountId: p.depositAccountId,
  depositSubAccountId: p.depositSubAccountId,
  journalId: p.journalId,
  voidedAt: p.voidedAt,
  voidReason: p.voidReason,
  voidJournalId: p.voidJournalId,
});

/**
 * 請求書の詳細（H:§3.6）。保存した写し（請求書・明細）と消し込みだけから作る
 * （設定・条件・取引先を見ない。INV-38）
 */
export function buildInvoiceDetail(
  invoice: InvoiceRecord,
  items: readonly InvoiceItemRecord[],
  payments: readonly PaymentRecord[],
  today?: string,
): InvoiceDetail {
  return {
    ...buildInvoiceSummary(invoice, payments, today),
    salesDate: invoice.salesDate,
    priceMode: invoice.priceMode ?? "inclusive",
    recipientHonorific: invoice.recipientHonorific,
    issuer: invoice.issuer,
    taxDisplay: invoice.taxDisplay,
    items: items.map((i) => ({
      lineNo: i.lineNo,
      name: i.name,
      quantity: i.quantityHalves === null ? null : i.quantityHalves / 2,
      unit: i.unit,
      unitPrice: i.unitPrice,
      amount: i.amount,
      taxCategory: i.taxCategory,
      taxRate: i.taxRate,
    })),
    taxBreakdown: calculateInvoiceAmounts(items, invoice.priceMode ?? "inclusive").taxBreakdown,
    journalId: invoice.journalId,
    voidJournalId: invoice.voidJournalId,
    voidedAt: invoice.voidedAt,
    voidReason: invoice.voidReason,
    payments: payments.map(toPaymentView),
    ...withholdingStanding(invoice, payments),
  };
}
