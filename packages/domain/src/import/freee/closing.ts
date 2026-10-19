import type { FiscalPeriod } from "../../types.ts";
import type { FreeeJournal } from "./read.ts";

/**
 * 年初付の前年分の決算振替か（research R5）。
 * 「決算整理仕訳 = 1」かつ「日付が会計期間の開始日」のときだけ true。12-31 付の減価償却などは false
 */
export function isPriorYearClosing(
  journal: Pick<FreeeJournal, "date" | "adjustment">,
  periods: readonly Pick<FiscalPeriod, "startDate">[],
): boolean {
  return journal.adjustment && periods.some((p) => p.startDate === journal.date);
}
