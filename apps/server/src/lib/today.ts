import type { Clock } from "@trebuchet/domain";

/**
 * 時計の今を暦日（`YYYY-MM-DD`）にする（005 R22）。ドメインはタイムゾーンを扱わず、
 * この値を `today` として受け取る。`timeZone` を省略すると、実行環境の既定（Mac のローカル）。
 * 0 時〜9 時（UTC と日付がずれる時間）に前日の日付にならないよう、UTC では切らない
 */
export function todayOf(clock: Clock, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    ...(timeZone === undefined ? {} : { timeZone }),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(clock.now()));
  const part = (type: "year" | "month" | "day") => {
    const value = parts.find((p) => p.type === type)?.value;
    if (value === undefined) throw new Error(`todayOf: ${type} を取り出せません`);
    return value;
  };
  return `${part("year")}-${part("month")}-${part("day")}`;
}
