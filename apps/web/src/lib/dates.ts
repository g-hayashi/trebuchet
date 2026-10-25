const pad2 = (n: number) => String(n).padStart(2, "0");

/** 今日の日付（ローカル時刻の YYYY-MM-DD） */
export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 今月（ローカル時刻の YYYY-MM） */
export function thisMonth(): string {
  return today().slice(0, 7);
}

/** 今年（ローカル時刻） */
export function thisYear(): number {
  return new Date().getFullYear();
}

/** 日付（YYYY-MM-DD）の前日 */
export function previousDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** 日付（YYYY-MM-DD）に日数を足す（負の数で引く） */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 月（YYYY-MM）の前の月 */
export function previousMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const [y, pm] = m === 1 ? [year - 1, 12] : [year, m - 1];
  return `${y}-${pad2(pm)}`;
}
