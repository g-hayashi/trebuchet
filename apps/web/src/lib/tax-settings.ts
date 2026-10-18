import type { AccountingMethod, TaxpayerStatus } from "@trebuchet/schema";

export const TAXPAYER_STATUS_LABELS: Record<TaxpayerStatus, string> = {
  exempt: "免税",
  general: "課税（本則）",
  simplified: "課税（簡易）",
  two_tenths: "課税（2割特例）",
};

export const ACCOUNTING_METHOD_LABELS: Record<AccountingMethod, string> = {
  tax_included: "税込経理",
  tax_excluded: "税抜経理",
};

function previousDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** 消費税の設定を適用開始日の順に並べ、適用終了日（次の設定の前日。最後は null）を付ける */
export function withEffectiveTo<S extends { effectiveFrom: string }>(
  settings: readonly S[],
): (S & { effectiveTo: string | null })[] {
  const sorted = [...settings].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  return sorted.map((s, i) => {
    const next = sorted[i + 1];
    return { ...s, effectiveTo: next === undefined ? null : previousDay(next.effectiveFrom) };
  });
}
