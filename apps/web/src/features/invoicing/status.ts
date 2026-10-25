import type { InvoiceListStatus, InvoiceStatus } from "@trebuchet/schema";

/** 請求書の状態の表示名（状態は残額と取消だけで決まる。data-model §3） */
export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  unpaid: "未入金",
  partial: "一部入金",
  paid: "入金済み",
  voided: "取消済み",
};

/** 一覧の絞り込みの選択肢（`overdue` は状態ではなく期限切れの判定。H:§3.5） */
export const INVOICE_LIST_STATUS_LABELS: Record<InvoiceListStatus, string> = {
  ...INVOICE_STATUS_LABELS,
  overdue: "期限切れ",
};

export const INVOICE_LIST_STATUSES = [
  "unpaid",
  "partial",
  "paid",
  "voided",
  "overdue",
] as const satisfies readonly InvoiceListStatus[];
