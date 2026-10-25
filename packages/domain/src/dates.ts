/** 日付（YYYY-MM-DD）の計算。暦日だけを扱い、タイムゾーンの影響を受けないよう UTC で計算する */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

const pad = (n: number, width = 2) => n.toString().padStart(width, "0");

function toUtcMs(date: string): number {
  const m = DATE_RE.exec(date);
  if (m === null) return Number.NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function fromUtcMs(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** YYYY-MM-DD の形式で、実在する日付か */
export function isValidDate(date: string): boolean {
  const ms = toUtcMs(date);
  return !Number.isNaN(ms) && fromUtcMs(ms) === date;
}

export function addDays(date: string, days: number): string {
  return fromUtcMs(toUtcMs(date) + days * DAY_MS);
}

/** `to` から `from` を引いた日数（`to` が後なら正）。どちらも実在する日付 */
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtcMs(to) - toUtcMs(from)) / DAY_MS);
}

/** 年度の開始日（年と開始月から） */
export function fiscalYearStart(fiscalYear: number, startMonth: number): string {
  return `${pad(fiscalYear, 4)}-${pad(startMonth)}-01`;
}

/** 開始日から1年の期間の終了日（翌年の同じ月日の前日）。開始日は月の1日を想定する */
export function oneYearEnd(startDate: string): string {
  const m = DATE_RE.exec(startDate);
  if (m === null) throw new RangeError(`不正な日付: ${startDate}`);
  return addDays(`${pad(Number(m[1]) + 1, 4)}-${m[2]}-${m[3]}`, -1);
}

// --- 月（YYYY-MM）の計算 ---

const MONTH_RE = /^(\d{4})-(\d{2})$/;

/** 月（`YYYY-MM`）を年と月（1〜12）に分ける。不正なら RangeError */
function parseMonth(month: string): { year: number; mon: number } {
  const m = MONTH_RE.exec(month);
  const mon = Number(m?.[2]);
  if (m === null || mon < 1 || mon > 12) throw new RangeError(`不正な月: ${month}`);
  return { year: Number(m[1]), mon };
}

/** 日付（`YYYY-MM-DD`）の月（`YYYY-MM`） */
export const monthOfDate = (date: string): string => date.slice(0, 7);

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

/** 月（`YYYY-MM`）の通し番号（年 × 12 + 月 - 1）。月の大小・差の計算に使う */
export function monthIndex(month: string): number {
  const { year, mon } = parseMonth(month);
  return year * 12 + mon - 1;
}

/** `monthIndex` の逆（`YYYY-MM`） */
export function monthAtIndex(index: number): string {
  return `${pad(Math.floor(index / 12), 4)}-${pad((index % 12) + 1)}`;
}

/** 月（`YYYY-MM`）の `months` か月後の月。年をまたぐ（12 月 + 1 か月 = 翌年 1 月） */
export function addMonths(month: string, months: number): string {
  return monthAtIndex(monthIndex(month) + months);
}

/**
 * 月（`YYYY-MM`）の `day` 日を `YYYY-MM-DD` で返す。その月の末日を超えるときは末日にする
 * （`day` は 1〜28 または 31 = 末日）
 */
export function dateInMonth(month: string, day: number): string {
  const { year, mon } = parseMonth(month);
  return `${pad(year, 4)}-${pad(mon)}-${pad(clampDay(year, mon, day))}`;
}

/** 月（`YYYY-MM`）の末日を `YYYY-MM-DD` で返す */
export function monthEnd(month: string): string {
  return dateInMonth(month, 31);
}
