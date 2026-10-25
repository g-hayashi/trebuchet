import type { InvoiceStatus } from "@trebuchet/schema";
import type { InvoiceRecord, PaymentRecord } from "../types.ts";

/**
 * 請求書の状態と残額（005 R14、INV-33）。状態は保存せず、取消の列と消し込みから導く。
 * 充当額 = 入金額 + 手数料。取消済みの消し込みは数えない
 */
export type InvoiceStanding = {
  status: InvoiceStatus;
  /** 充当額の合計（取消でない消し込み） */
  paid: number;
  /** 残額 = 合計 − 充当額。取消の請求書は 0（未回収に数えない） */
  remaining: number;
};

/**
 * 期限切れの判定（R14、FR-020）。状態ではなく表示用: 残額 > 0 かつ 今日 > 支払期限。
 * 支払期限の当日は偽、翌日から真。取消の請求書は偽。日付は `YYYY-MM-DD`（文字列の比較で足りる）
 */
export function isOverdue(
  invoice: Pick<InvoiceRecord, "dueDate" | "voidedAt">,
  remaining: number,
  today: string,
): boolean {
  return invoice.voidedAt === null && remaining > 0 && today > invoice.dueDate;
}

export function invoiceStatus(
  invoice: Pick<InvoiceRecord, "total" | "voidedAt">,
  payments: readonly Pick<PaymentRecord, "amount" | "feeAmount" | "voidedAt">[],
): InvoiceStanding {
  let paid = 0;
  for (const p of payments) {
    if (p.voidedAt === null) paid += p.amount + p.feeAmount;
  }
  if (invoice.voidedAt !== null) return { status: "voided", paid, remaining: 0 };
  const remaining = Math.max(0, invoice.total - paid);
  const status: InvoiceStatus = remaining === 0 ? "paid" : paid === 0 ? "unpaid" : "partial";
  return { status, paid, remaining };
}
