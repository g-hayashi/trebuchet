import { type DomainError, domainError } from "../types.ts";

/**
 * 前年までの償却累計額と、その累計の年の検査（定額法・一括償却資産・開業費。009）。
 * 累計は 0 以上 `max` 以下の整数、0 より大きければ累計の年が必要、累計の年は整数で `startYear` 以上。
 * 上限と文言は方法ごとに違うので引数で受ける。失敗は `PRIOR_ACCUMULATED_INVALID`（`details.field` つき）
 */
export function checkPriorAccumulation(
  draft: { priorAccumulated: number; priorThroughYear: number | null },
  rule: { max: number; maxMessage: string; startYear: number; startYearMessage: string },
): DomainError | null {
  const fail = (field: "priorAccumulated" | "priorThroughYear", message: string) =>
    domainError("PRIOR_ACCUMULATED_INVALID", message, { field });
  if (
    !Number.isSafeInteger(draft.priorAccumulated) ||
    draft.priorAccumulated < 0 ||
    draft.priorAccumulated > rule.max
  ) {
    return fail("priorAccumulated", rule.maxMessage);
  }
  const through = draft.priorThroughYear;
  if (through !== null && !Number.isSafeInteger(through)) {
    return fail("priorThroughYear", "累計の年は整数で入力してください");
  }
  if (draft.priorAccumulated > 0 && through === null) {
    return fail("priorThroughYear", "前年までの償却累計額には、何年分までかの入力が必要です");
  }
  if (through !== null && through < rule.startYear) {
    return fail("priorThroughYear", rule.startYearMessage);
  }
  return null;
}
