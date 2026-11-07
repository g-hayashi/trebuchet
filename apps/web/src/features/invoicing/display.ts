import type { InvoiceDetail } from "@trebuchet/schema";
import { formatYen } from "@/lib/format";
import type { BillingTermsRow } from "./api";

/** 取引先の一覧の「請求」の欄。条件がなければ「未設定」 */
export function billingSummary(terms: BillingTermsRow | undefined): string {
  if (terms === undefined) return "未設定";
  const base =
    terms.billingType === "hourly"
      ? `時間単価 ${formatYen(terms.unitPrice ?? 0)} 円`
      : `月額 ${formatYen(terms.monthlyAmount ?? 0)} 円`;
  return terms.withholding === true ? `${base}・源泉徴収あり` : base;
}

/** 取引先の宛名（敬称つき） */
export const recipientOf = (invoice: Pick<InvoiceDetail, "recipientName" | "recipientHonorific">) =>
  `${invoice.recipientName} ${invoice.recipientHonorific}`;

/** 数量と単位の表示（「40.5 時間」）。数量がなければ空 */
export const quantityOf = (item: { quantity: number | null; unit: string | null }) =>
  item.quantity === null ? "" : `${item.quantity}${item.unit ? ` ${item.unit}` : ""}`;

/** 発行時に保存した内訳を表示用に集計する。現在の設定による再計算はしない */
export const invoiceTaxSummary = (invoice: InvoiceDetail) => ({
  modeLabel: invoice.priceMode === "exclusive" ? "税抜" : "税込",
  exclusive: invoice.priceMode === "exclusive",
  subtotal: invoice.items.reduce((sum, item) => sum + item.amount, 0),
  tax: invoice.taxBreakdown.reduce((sum, item) => sum + item.tax, 0),
  taxLabel: invoice.issuer.registrationNumber === null ? "消費税相当額" : "消費税",
});
