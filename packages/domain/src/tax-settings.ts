import type { AccountingMethod, TaxpayerStatus } from "@trebuchet/schema";
import { isValidDate } from "./dates.ts";
import { compareText } from "./text.ts";
import { domainError, err, ok, type Result, validation } from "./types.ts";

/** 消費税の設定の1行（ID なし。保存済みの TaxSetting もこの形を満たす） */
export type TaxSettingDraft = {
  effectiveFrom: string;
  taxpayerStatus: TaxpayerStatus;
  accountingMethod: AccountingMethod;
};

/**
 * 消費税の設定の列を検証し、適用開始日の順に並べて返す（FR-009）。
 * 各行は次の行の前日まで適用されるため、空白が生じうるのは最初の会計期間の開始日と最初の行の間だけ。
 */
export function validateTaxSettings<T extends TaxSettingDraft>(
  settings: readonly T[],
  firstPeriodStart: string,
): Result<T[]> {
  for (const [index, s] of settings.entries()) {
    if (!isValidDate(s.effectiveFrom)) {
      return validation("適用開始日が正しい日付ではありません", {
        index,
        effectiveFrom: s.effectiveFrom,
      });
    }
    if (s.taxpayerStatus === "exempt" && s.accountingMethod !== "tax_included") {
      return validation("免税事業者の期間は税込経理のみ選べます", {
        index,
        effectiveFrom: s.effectiveFrom,
      });
    }
  }

  const sorted = [...settings].sort((a, b) => compareText(a.effectiveFrom, b.effectiveFrom));
  const first = sorted[0];
  if (first === undefined) {
    return err(
      domainError("TAX_SETTING_GAP", "消費税の設定を1件以上登録してください", {
        firstPeriodStart,
      }),
    );
  }
  for (let i = 1; i < sorted.length; i += 1) {
    const date = sorted[i]?.effectiveFrom;
    if (date === sorted[i - 1]?.effectiveFrom) {
      return err(
        domainError("TAX_SETTING_GAP", "適用開始日が重複しています", { effectiveFrom: date }),
      );
    }
  }
  if (first.effectiveFrom > firstPeriodStart) {
    return err(
      domainError(
        "TAX_SETTING_GAP",
        "最初の設定の適用開始日を、最初の会計期間の開始日以前にしてください",
        { effectiveFrom: first.effectiveFrom, firstPeriodStart },
      ),
    );
  }
  return ok(sorted);
}

/** date に適用される設定（effectiveFrom <= date のうち最新）。なければ undefined */
export function resolveTaxSetting<T extends TaxSettingDraft>(
  date: string,
  settings: readonly T[],
): T | undefined {
  let latest: T | undefined;
  for (const s of settings) {
    if (s.effectiveFrom > date) continue;
    if (latest === undefined || s.effectiveFrom > latest.effectiveFrom) latest = s;
  }
  return latest;
}
