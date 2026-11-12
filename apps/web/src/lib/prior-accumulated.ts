import { YEAR_PATTERN } from "@trebuchet/schema";
import { parseWholeYen } from "@/lib/format";

// 固定資産（定額法・一括償却）と開業費の「前年までの償却累計額」と「何年分まで」の入力の共通部分（009）

export const PRIOR_ERROR = "前年までの償却累計額は0以上の整数で入力してください";
export const PRIOR_YEAR_ERROR = "累計が何年分までかを入力してください（4桁の年）";

/** 入力欄の文字列 */
export type PriorFields = { priorAccumulated: string; priorThroughYear: string };

/** 保存済みの値から入力欄の文字列にする（0 の累計は空欄） */
export const priorFieldsOf = (row: {
  priorAccumulated: number;
  priorThroughYear: number | null;
}): PriorFields => ({
  priorAccumulated: row.priorAccumulated > 0 ? String(row.priorAccumulated) : "",
  priorThroughYear: row.priorThroughYear === null ? "" : String(row.priorThroughYear),
});

/**
 * 累計と年の検査と整形。累計が空なら 0、年が空なら null。累計が正なら年が要る。
 * 誤りがなければ value が入り、あれば欄ごとのメッセージが入る
 */
export function parsePriorAccumulated(v: PriorFields): {
  value: { prior: number; year: number | null } | undefined;
  priorError: string | undefined;
  priorYearError: string | undefined;
} {
  const prior =
    v.priorAccumulated.trim() === "" ? 0 : parseWholeYen(v.priorAccumulated, { min: 0 });
  const yearText = v.priorThroughYear.trim();
  const year = yearText === "" ? null : YEAR_PATTERN.test(yearText) ? Number(yearText) : undefined;
  const priorError = prior === null ? PRIOR_ERROR : undefined;
  const priorYearError =
    year === undefined || (prior !== null && prior > 0 && year === null)
      ? PRIOR_YEAR_ERROR
      : undefined;
  const value =
    prior === null || year === undefined || priorYearError ? undefined : { prior, year };
  return { value, priorError, priorYearError };
}
