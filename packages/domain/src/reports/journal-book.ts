import type {
  JournalBook,
  JournalBookEntry,
  JournalBookOrder,
  JournalBookSort,
} from "@trebuchet/schema";
import type { PostedLine } from "../types.ts";
import { isActive } from "./common.ts";

export type JournalBookInput = {
  lines: readonly PostedLine[];
  from: string;
  to: string;
  sort?: JournalBookSort | undefined;
  order?: JournalBookOrder | undefined;
};

/** 仕訳の並び。sort の値 → 仕訳番号 の順（行は並べない） */
function journalOrder(sort: JournalBookSort, order: JournalBookOrder) {
  const key = (l: PostedLine) => (sort === "created" ? l.createdAt : l.date);
  const sign = order === "desc" ? -1 : 1;
  return (a: PostedLine, b: PostedLine): number => {
    const ka = key(a);
    const kb = key(b);
    if (ka !== kb) return (ka < kb ? -1 : 1) * sign;
    return (a.journalNo - b.journalNo) * sign;
  };
}

/**
 * 仕訳帳（FR-026, FR-038）: 期間内の有効な仕訳を並べる。既定は 日付 → 仕訳番号 の昇順。
 * `created` は登録日時 → 仕訳番号。行は仕訳の中で常に行番号の順（降順でも）
 */
export function buildJournalBook(input: JournalBookInput): JournalBook {
  const byJournal = journalOrder(input.sort ?? "date", input.order ?? "asc");
  const lines = input.lines
    .filter((l) => isActive(l) && l.date >= input.from && l.date <= input.to)
    .sort((a, b) => byJournal(a, b) || a.lineNo - b.lineNo);
  const entries: JournalBookEntry[] = [];
  const totals = { debit: 0, credit: 0 };
  let current: JournalBookEntry | undefined;
  for (const l of lines) {
    if (current?.journalId !== l.journalId) {
      current = {
        journalId: l.journalId,
        journalNo: l.journalNo,
        date: l.date,
        memo: l.memo,
        lines: [],
      };
      entries.push(current);
    }
    current.lines.push({
      lineNo: l.lineNo,
      side: l.side,
      accountId: l.accountId,
      accountName: l.accountName,
      subAccountId: l.subAccountId,
      subAccountName: l.subAccountName,
      partnerId: l.partnerId,
      partnerName: l.partnerName,
      amount: l.amount,
      taxCategory: l.taxCategory,
      taxAmount: l.taxAmount,
      description: l.description,
    });
    totals[l.side] += l.amount;
  }
  return { kind: "journal-book", from: input.from, to: input.to, entries, totals };
}
