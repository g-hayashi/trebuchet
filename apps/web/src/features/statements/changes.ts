import { formatYen } from "@/lib/format";
import { CONTENT_FIELD_LABELS } from "./labels";

/** 変更あり（`external_id` が同じで内容が違う）の変更前後。取込のプレビューと明細の一覧が使う */
export type ContentChange = {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
};

const formatValue = (value: unknown): string => {
  if (value === null || value === undefined || value === "") return "なし";
  return typeof value === "number" ? formatYen(value) : String(value);
};

/** 変更前後で値が違う項目だけを「項目: 前 → 後」の文にする */
export function changedFields(changed: ContentChange): string[] {
  const keys = [...new Set([...Object.keys(changed.before), ...Object.keys(changed.after)])];
  return keys
    .filter((k) => changed.before[k] !== changed.after[k])
    .map(
      (k) =>
        `${CONTENT_FIELD_LABELS[k] ?? k}: ${formatValue(changed.before[k])} → ${formatValue(changed.after[k])}`,
    );
}
