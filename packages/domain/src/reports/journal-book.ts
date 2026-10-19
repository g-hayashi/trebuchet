import type { JournalBook, JournalBookEntry } from "@trebuchet/schema";
import type { PostedLine } from "../types.ts";
import { compareLines, isActive } from "./common.ts";

export type JournalBookInput = { lines: readonly PostedLine[]; from: string; to: string };

/** 仕訳帳（FR-026）: 期間内の有効な仕訳を 日付 → 仕訳番号 の順に、行は行番号の順に並べる */
export function buildJournalBook(input: JournalBookInput): JournalBook {
  const lines = input.lines
    .filter((l) => isActive(l) && l.date >= input.from && l.date <= input.to)
    .sort(compareLines);
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
