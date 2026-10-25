import type { InvoiceStatus } from "@trebuchet/schema";

/** 請求書の状態の表示名（状態は残額と取消だけで決まる。data-model §3） */
export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  unpaid: "未入金",
  partial: "一部入金",
  paid: "入金済み",
  voided: "取消済み",
};
