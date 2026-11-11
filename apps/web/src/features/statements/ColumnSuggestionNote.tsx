import { useQuery } from "@tanstack/react-query";
import type {
  StatementColumnIndexes,
  StatementColumnSuggestionOptions,
  StatementColumnSuggestionResponse,
  StatementTableLayout,
} from "@trebuchet/schema";
import { useEffect, useRef } from "react";
import { columnSuggestionQuery } from "./api";
import { AMOUNT_SIGN_LABELS } from "./labels";

/** AI の案（案があるときの `suggestion`） */
export type ColumnAiSuggestion = NonNullable<StatementColumnSuggestionResponse["suggestion"]>;

/**
 * 日付・内容と、金額（1 列）か出金・入金の一方がそろっているか。辞書の案でそろえば AI に尋ねない（FR-016）。
 * サーバーも同じ判定で呼ばない（`suggestStatementColumns`）。ここは無駄な要求を出さないための画面側の判定
 */
function hasRequiredRoles(columns: StatementColumnIndexes): boolean {
  if (columns.date === undefined || columns.content === undefined) return false;
  const amount = columns.amount !== undefined;
  const outflow = columns.outflow !== undefined;
  const inflow = columns.inflow !== undefined;
  return (amount && !outflow && !inflow) || (!amount && outflow && inflow);
}

/** 案を要求する表か: 保存した取込元が当てはまらず、辞書の案で必須の役割がそろわない */
export const needsColumnSuggestion = (layout: StatementTableLayout): boolean =>
  layout.match.kind === "none" && !hasRequiredRoles(layout.suggestedColumns);

const UNAVAILABLE_MESSAGES: Record<
  NonNullable<StatementColumnSuggestionResponse["unavailable"]>,
  string
> = {
  disabled: "端末内の AI は無効です（設定で有効にできます）。列は手で選んでください。",
  unavailable: "端末内の AI を使えないため、案はありません。",
  timeout: "AI の応答が時間内に返らなかったため、案はありません。",
  invalid: "AI の案が正しい形ではなかったため、使いませんでした。",
};

/**
 * 列の対応の案（端末内の AI。US4）を要求して示す。要求の間も、列の選択は使える（待たない）。
 * 案が来たら一度だけ `onSuggestion` に渡す（列への入れ方は呼び出し側）。案は「AI の案」と示し、利用者が確かめてから進む
 */
export function ColumnSuggestionNote({
  entityId,
  file,
  options,
  onSuggestion,
}: {
  entityId: string;
  file: File;
  options: StatementColumnSuggestionOptions;
  onSuggestion: (suggestion: ColumnAiSuggestion) => void;
}) {
  const query = useQuery(columnSuggestionQuery(entityId, file, options));
  const delivered = useRef(false);
  const suggestion = query.data?.suggestion;
  useEffect(() => {
    if (suggestion && !delivered.current) {
      delivered.current = true;
      onSuggestion(suggestion);
    }
  }, [suggestion, onSuggestion]);

  if (query.isPending) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        AI の案を作っています…
      </p>
    );
  }
  if (query.isError) {
    return <p className="text-sm text-muted-foreground">AI の案を作れませんでした</p>;
  }
  if (suggestion && query.data?.unavailable !== undefined) {
    // 案と理由が両方あるのは、AI を使えず、列の中身から推定しただけのとき（AI の案ではない。007/R16）
    return (
      <p className="text-sm text-muted-foreground">
        {UNAVAILABLE_MESSAGES[query.data.unavailable]}
        列の中身から推定した案を、選んでいない列に入れました。確かめてから進んでください。
      </p>
    );
  }
  if (suggestion) {
    return (
      <p className="text-sm text-muted-foreground">
        AI の案（確信度 {suggestion.confidence}）を、選んでいない列に入れました。
        {suggestion.amountSign !== null &&
          `金額の符号の案: ${AMOUNT_SIGN_LABELS[suggestion.amountSign]}。`}
        確かめてから進んでください。
      </p>
    );
  }
  const unavailable = query.data?.unavailable;
  return unavailable === undefined ? null : (
    <p className="text-sm text-muted-foreground">{UNAVAILABLE_MESSAGES[unavailable]}</p>
  );
}
