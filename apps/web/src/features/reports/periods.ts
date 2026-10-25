import { useQuery } from "@tanstack/react-query";
import { type FiscalPeriod, fiscalPeriodsQuery } from "@/features/periods/api";
import { today } from "@/lib/dates";

export type DateRange = { from: string; to: string };

export const periodOf = (periods: readonly FiscalPeriod[], date: string) =>
  periods.find((p) => p.startDate <= date && date <= p.endDate);

const latest = (periods: readonly FiscalPeriod[]) =>
  periods.reduce<FiscalPeriod | undefined>(
    (max, p) => (max === undefined || p.endDate > max.endDate ? p : max),
    undefined,
  );

/** 今日を含む会計期間。なければ最新の会計期間 */
function currentPeriod(periods: readonly FiscalPeriod[]) {
  return periodOf(periods, today()) ?? latest(periods);
}

/**
 * 帳票の期間。URL に開始日・終了日がなければ、今日を含む会計期間（なければ最新の会計期間）にする
 */
export function useReportRange(
  entityId: string,
  search: { from?: string | undefined; to?: string | undefined },
) {
  const periods = useQuery(fiscalPeriodsQuery(entityId));
  let range: DateRange | undefined;
  if (search.from !== undefined && search.to !== undefined) {
    range = { from: search.from, to: search.to };
  } else if (periods.data) {
    const period = currentPeriod(periods.data);
    if (period) range = { from: period.startDate, to: period.endDate };
  }
  return { periods: periods.data, range, error: periods.error, isPending: periods.isPending };
}

/** 貸借対照表の基準日。URL になければ、今日（会計期間の外なら最新の会計期間の終了日） */
export function useReportAsOf(entityId: string, asOf: string | undefined) {
  const periods = useQuery(fiscalPeriodsQuery(entityId));
  let resolved = asOf;
  if (resolved === undefined && periods.data) {
    const date = today();
    resolved = periodOf(periods.data, date) ? date : latest(periods.data)?.endDate;
  }
  return {
    periods: periods.data,
    asOf: resolved,
    error: periods.error,
    isPending: periods.isPending,
  };
}
