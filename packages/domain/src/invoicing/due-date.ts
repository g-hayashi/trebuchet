import { addMonths, dateInMonth } from "../dates.ts";

/**
 * 支払期限の純関数（005 R8、INV-36）。日（`day`）は「1〜28 または 31（末日）」で持ち、
 * その月の末日を超えたら末日にする
 */

/**
 * 対象月（`YYYY-MM`）の `monthsAfter` か月後の月の `day` 日（末日を超えるときは末日）を
 * `YYYY-MM-DD` で返す。年をまたぐ（12 月分 + 1 か月 = 翌年 1 月）
 */
export function dueDate(targetMonth: string, monthsAfter: number, day: number): string {
  return dateInMonth(addMonths(targetMonth, monthsAfter), day);
}
