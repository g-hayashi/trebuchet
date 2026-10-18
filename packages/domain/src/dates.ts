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
