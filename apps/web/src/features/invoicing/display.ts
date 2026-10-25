import type { InvoiceDetail } from "@trebuchet/schema";

/** 取引先の宛名（敬称つき） */
export const recipientOf = (invoice: Pick<InvoiceDetail, "recipientName" | "recipientHonorific">) =>
  `${invoice.recipientName} ${invoice.recipientHonorific}`;

/** 数量と単位の表示（「40.5 時間」）。数量がなければ空 */
export const quantityOf = (item: { quantity: number | null; unit: string | null }) =>
  item.quantity === null ? "" : `${item.quantity}${item.unit ? ` ${item.unit}` : ""}`;
