import type { JournalSuggestion, JournalSuggestionQuery } from "@trebuchet/schema";
import { normalizeContent } from "../statements/normalize.ts";
import type { Journal } from "../types.ts";

/** 有効な2行仕訳の履歴から、摘要または左右いずれかの取引先が一致する候補を返す。 */
export function suggestFromHistory(
  journals: readonly Journal[],
  query: JournalSuggestionQuery,
): JournalSuggestion[] {
  const memo = normalizeContent(query.memo ?? "");
  if (!memo && !query.partnerId) return [];
  const suggestions: JournalSuggestion[] = [];
  const seen = new Set<string>();
  const sorted = [...journals].sort(
    (a, b) => b.date.localeCompare(a.date) || b.journalNo - a.journalNo,
  );
  for (const journal of sorted) {
    if (journal.status !== "active" || journal.lines.length !== 2) continue;
    const debit = journal.lines.find((line) => line.side === "debit");
    const credit = journal.lines.find((line) => line.side === "credit");
    if (debit === undefined || credit === undefined) continue;
    const memoMatches = memo !== "" && normalizeContent(journal.memo ?? "") === memo;
    const partnerMatches =
      query.partnerId !== undefined &&
      (debit.partnerId === query.partnerId || credit.partnerId === query.partnerId);
    if (!memoMatches && !partnerMatches) continue;
    const key = JSON.stringify([
      debit.accountId,
      credit.accountId,
      debit.taxCategory,
      credit.taxCategory,
      debit.partnerId,
      credit.partnerId,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    suggestions.push({
      debitAccountId: debit.accountId,
      creditAccountId: credit.accountId,
      debitTaxCategory: debit.taxCategory,
      creditTaxCategory: credit.taxCategory,
      debitPartnerId: debit.partnerId,
      creditPartnerId: credit.partnerId,
      sourceJournalId: journal.id,
      date: journal.date,
    });
    if (suggestions.length === 3) break;
  }
  return suggestions;
}
