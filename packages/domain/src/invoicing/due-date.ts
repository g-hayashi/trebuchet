/**
 * 支払期限の純関数（005 R8、INV-36）。日（`day`）は「1〜28 または 31（末日）」で持ち、
 * その月の末日を超えたら末日にする
 */

const pad = (n: number, width = 2) => n.toString().padStart(width, "0");

const isLeapYear = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/** その月の日数（`month` は 1〜12） */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** `day` がその月の末日を超えるときは末日にする（31 = 末日） */
export function clampDay(year: number, month: number, day: number): number {
  return Math.min(day, daysInMonth(year, month));
}

/** 月（`YYYY-MM`）の末日を `YYYY-MM-DD` で返す（売上の計上日の既定。R8） */
export function monthEnd(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (m === null) throw new RangeError(`不正な月: ${month}`);
  const year = Number(m[1]);
  const mon = Number(m[2]);
  return `${pad(year, 4)}-${pad(mon)}-${pad(daysInMonth(year, mon))}`;
}

/**
 * 対象月（`YYYY-MM`）の `monthsAfter` か月後の月の `day` 日（末日を超えるときは末日）を
 * `YYYY-MM-DD` で返す。年をまたぐ（12 月分 + 1 か月 = 翌年 1 月）
 */
export function dueDate(targetMonth: string, monthsAfter: number, day: number): string {
  const m = /^(\d{4})-(\d{2})$/.exec(targetMonth);
  if (m === null) throw new RangeError(`不正な月: ${targetMonth}`);
  const total = Number(m[1]) * 12 + (Number(m[2]) - 1) + monthsAfter;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return `${pad(year, 4)}-${pad(month)}-${pad(clampDay(year, month, day))}`;
}
