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

/** 先月（ローカル時刻の YYYY-MM）。請求・工数の月の既定 */
export function lastMonth(): string {
  return previousMonth(thisMonth());
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

/** 帳票の期間のプリセット（011/FR-040）。暦の月・四半期・年 */
export type RangePreset = "this-month" | "last-month" | "this-quarter" | "this-year" | "last-year";

export const RANGE_PRESETS: readonly { id: RangePreset; label: string }[] = [
  { id: "this-month", label: "今月" },
  { id: "last-month", label: "先月" },
  { id: "this-quarter", label: "今四半期" },
  { id: "this-year", label: "今年" },
  { id: "last-year", label: "昨年" },
];

/** 月（YYYY-MM）の初日〜末日 */
function monthRange(month: string): { from: string; to: string } {
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  // 翌月の 0 日 = 月末（UTC で計算し、時差の影響を受けない）
  const last = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${pad2(last)}` };
}

/** プリセットの期間（date は基準の日。既定は今日） */
export function presetRange(
  preset: RangePreset,
  date: string = today(),
): { from: string; to: string } {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  switch (preset) {
    case "this-month":
      return monthRange(date.slice(0, 7));
    case "last-month":
      return monthRange(previousMonth(date.slice(0, 7)));
    case "this-quarter": {
      const first = Math.floor((month - 1) / 3) * 3 + 1;
      return {
        from: `${year}-${pad2(first)}-01`,
        to: monthRange(`${year}-${pad2(first + 2)}`).to,
      };
    }
    case "this-year":
      return { from: `${year}-01-01`, to: `${year}-12-31` };
    case "last-year":
      return { from: `${year - 1}-01-01`, to: `${year - 1}-12-31` };
  }
}
