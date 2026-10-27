import type { StatementTableLayout } from "@trebuchet/schema";
import type { ColumnSuggestionProvider } from "../ports.ts";
import {
  buildColumnPrompt,
  type ColumnSuggestion,
  hasRequiredColumns,
  parseColumnSuggestion,
} from "../statements/column-prompt.ts";

// 端末内の AI による列の対応の案（007/R10、FR-016・FR-018、contracts §4.1）。値は帳簿に書かない（案を返すだけ）

/** provider が時間切れの失敗に付ける details。ユースケースはこれで `timeout` と他の失敗を見分ける */
export const COLUMN_TIMEOUT_DETAIL = { timeout: true } as const;

/** 案を作れなかった理由。`disabled` は AI の設定で端末内が無効（provider を渡さない） */
export type ColumnSuggestionUnavailable = "disabled" | "unavailable" | "timeout" | "invalid";

export type ColumnSuggestionResult = {
  suggestion: ColumnSuggestion | null;
  /** 案がないときだけ付く。AI を呼ぶ必要がなかったとき（辞書の案か保存した対応で足りる）は付かない */
  unavailable?: ColumnSuggestionUnavailable;
};

export type ColumnSuggestionDeps = {
  /** 端末内の AI。設定で無効なら渡さない（undefined） */
  provider: ColumnSuggestionProvider | undefined;
};

/** `suggestStatementColumns` が読む表の形（`detectStatementLayout` の戻りの一部） */
export type ColumnSuggestionLayout = Pick<
  StatementTableLayout,
  "header" | "sampleRows" | "columnCount" | "suggestedColumns" | "match"
>;

const none = (unavailable: ColumnSuggestionUnavailable): ColumnSuggestionResult => ({
  suggestion: null,
  unavailable,
});

/**
 * 列の案を AI に尋ねる。保存した取込元が当てはまる（`match` が none でない）か、辞書の案で必須の役割が
 * そろうときは呼ばず、案なしで返す（`unavailable` は付けない）。使えない・時間切れ・形の誤りは、案なしと理由で返す。
 * 渡すのは `buildColumnPrompt` の結果だけ（INV-48）
 */
export async function suggestStatementColumns(
  deps: ColumnSuggestionDeps,
  layout: ColumnSuggestionLayout,
): Promise<ColumnSuggestionResult> {
  if (layout.match.kind !== "none" || hasRequiredColumns(layout.suggestedColumns)) {
    return { suggestion: null };
  }
  const { provider } = deps;
  if (provider === undefined) return none("disabled");

  let response: Awaited<ReturnType<ColumnSuggestionProvider["suggestColumns"]>>;
  try {
    if (!(await provider.available())) return none("unavailable");
    response = await provider.suggestColumns(buildColumnPrompt(layout));
  } catch {
    return none("unavailable");
  }
  if (!response.ok) {
    return none(response.error.details?.timeout === true ? "timeout" : "unavailable");
  }
  const parsed = parseColumnSuggestion(response.value, layout.columnCount);
  return parsed.ok ? { suggestion: parsed.value } : none("invalid");
}
