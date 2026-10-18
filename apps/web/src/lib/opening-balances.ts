import type { Side } from "@trebuchet/schema";

export type OpeningTotals = { debit: number; credit: number; diff: number; balanced: boolean };

/** 期首残高の借方合計・貸方合計・差額（借方 − 貸方）。未入力の金額は 0 として数える */
export function openingTotals(
  rows: readonly { side: Side; amount: number | null | undefined }[],
): OpeningTotals {
  let debit = 0;
  let credit = 0;
  for (const row of rows) {
    const amount = typeof row.amount === "number" && Number.isFinite(row.amount) ? row.amount : 0;
    if (row.side === "debit") debit += amount;
    else credit += amount;
  }
  return { debit, credit, diff: debit - credit, balanced: debit === credit };
}
