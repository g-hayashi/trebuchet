import { clampDay } from "../invoicing/due-date.ts";

const pad = (n: number, width = 2) => n.toString().padStart(width, "0");

/** 月（`YYYY-MM`）の通し番号（年 × 12 + 月 - 1）。月の大小・差の計算に使う */
export function monthIndex(month: string): number {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (m === null || Number(m[2]) < 1 || Number(m[2]) > 12) {
    throw new RangeError(`不正な月: ${month}`);
  }
  return Number(m[1]) * 12 + Number(m[2]) - 1;
}

/** `monthIndex` の逆（`YYYY-MM`） */
export function monthAtIndex(index: number): string {
  return `${pad(Math.floor(index / 12), 4)}-${pad((index % 12) + 1)}`;
}

/**
 * 定期仕訳の予定日（005 R8）。`month`（`YYYY-MM`）の `day` 日を `YYYY-MM-DD` で返す。
 * `day` は 1〜28 または 31（末日）。その月の末日を超えるときは末日にする
 */
export function scheduledDate(month: string, day: number): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (m === null) throw new RangeError(`不正な月: ${month}`);
  const year = Number(m[1]);
  const mon = Number(m[2]);
  if (mon < 1 || mon > 12) throw new RangeError(`不正な月: ${month}`);
  return `${pad(year, 4)}-${pad(mon)}-${pad(clampDay(year, mon, day))}`;
}
