import { today } from "@/lib/dates";

/** 請求の対象月の既定。請求は月が明けてから作るので、今日の月の前の月（YYYY-MM） */
export function defaultTargetMonth(now: string = today()): string {
  const year = Number(now.slice(0, 4));
  const month = Number(now.slice(5, 7));
  const [y, m] = month === 1 ? [year - 1, 12] : [year, month - 1];
  return `${y}-${String(m).padStart(2, "0")}`;
}
