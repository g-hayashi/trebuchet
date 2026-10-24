import type { InvoiceDetail, InvoiceSummary, PaymentView } from "@trebuchet/schema";
import type { InvoiceItemRecord, InvoiceRecord, PaymentRecord } from "../types.ts";
import { invoiceStatus } from "./status.ts";
import { taxBreakdownEntries } from "./tax.ts";

/** 一覧の 1 行（H:§3.5）。`overdue` は US2（T017・T018）まで偽 */
export function buildInvoiceSummary(
  invoice: InvoiceRecord,
  payments: readonly PaymentRecord[],
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
    paid: standing.paid,
    remaining: standing.remaining,
    status: standing.status,
    overdue: false,
  };
}

const toPaymentView = (p: PaymentRecord): PaymentView => ({
  id: p.id,
  receivedOn: p.receivedOn,
  amount: p.amount,
  feeAmount: p.feeAmount,
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
): InvoiceDetail {
  return {
    ...buildInvoiceSummary(invoice, payments),
    salesDate: invoice.salesDate,
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
    taxBreakdown: taxBreakdownEntries(items),
    journalId: invoice.journalId,
    voidJournalId: invoice.voidJournalId,
    voidedAt: invoice.voidedAt,
    voidReason: invoice.voidReason,
    payments: payments.map(toPaymentView),
  };
}
