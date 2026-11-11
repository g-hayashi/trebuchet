import { useQuery } from "@tanstack/react-query";
import { type FiscalPeriod, fiscalPeriodsQuery } from "@/features/periods/api";
import { today } from "@/lib/dates";

/** 日付を含む会計期間 */
export const periodOf = (periods: readonly FiscalPeriod[], date: string) =>
  periods.find((p) => p.startDate <= date && date <= p.endDate);

/** 終了日が最も新しい会計期間 */
export const latest = (periods: readonly FiscalPeriod[]) =>
  periods.reduce<FiscalPeriod | undefined>(
    (max, p) => (max === undefined || p.endDate > max.endDate ? p : max),
    undefined,
  );

/** 今日を含む会計期間。なければ最新の会計期間 */
export function currentPeriod(periods: readonly FiscalPeriod[]) {
  return periodOf(periods, today()) ?? latest(periods);
}

/** 会計期間の一覧と、今日を含む（なければ最新の）会計期間。読み込み前は period が undefined */
export function useCurrentPeriod(entityId: string) {
  const query = useQuery(fiscalPeriodsQuery(entityId));
  return {
    periods: query.data,
    period: query.data && currentPeriod(query.data),
    error: query.error,
    isPending: query.isPending,
  };
}
