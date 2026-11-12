import { latest, periodOf, useCurrentPeriod } from "@/features/periods/current";
import { today } from "@/lib/dates";

export type DateRange = { from: string; to: string };

/**
 * 帳票の期間。URL に開始日・終了日がなければ、今日を含む会計期間（なければ最新の会計期間）にする
 */
export function useReportRange(
  entityId: string,
  search: { from?: string | undefined; to?: string | undefined },
) {
  const { periods, period, error, isPending } = useCurrentPeriod(entityId);
  let range: DateRange | undefined;
  if (search.from !== undefined && search.to !== undefined) {
    range = { from: search.from, to: search.to };
  } else if (period) {
    range = { from: period.startDate, to: period.endDate };
  }
  return { periods, range, error, isPending };
}

/** 貸借対照表の基準日。URL になければ、今日（会計期間の外なら最新の会計期間の終了日） */
export function useReportAsOf(entityId: string, asOf: string | undefined) {
  const { periods, error, isPending } = useCurrentPeriod(entityId);
  let resolved = asOf;
  if (resolved === undefined && periods) {
    const date = today();
    resolved = periodOf(periods, date) ? date : latest(periods)?.endDate;
  }
  return { periods, asOf: resolved, error, isPending };
}
