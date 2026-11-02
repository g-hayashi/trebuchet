import { daysBetween } from "../dates.ts";
import type { Journal, JournalRef, ReceiptRow } from "../types.ts";

// 証憑に結びつける仕訳の候補（data-model §2.4、research R6、FR-011）。純関数

/** 基準日の前後に探す日数 */
export const RECEIPT_CANDIDATE_WINDOW_DAYS = 14;
/** 返す候補の上限 */
export const RECEIPT_CANDIDATE_LIMIT = 20;

export type JournalCandidate = {
  journal: JournalRef;
  /** 借方合計 */
  total: number;
  /** 基準日との日数の差（絶対値） */
  daysDiff: number;
  /** 借方合計 = 証憑の金額（金額が未入力なら false） */
  amountMatches: boolean;
};

type CandidateJournal = Pick<Journal, "id" | "journalNo" | "date" | "status" | "lines">;

/**
 * 候補を並べる。基準日 = 取引年月日（なければ `receivedDate`、受領日の日付）。
 * 対象は基準日 ± `RECEIPT_CANDIDATE_WINDOW_DAYS` 日の有効な仕訳（呼び出し側が範囲で絞って渡すが、ここでも絞る）。
 * 並び: ①借方合計 = 金額 ②日付の差 ③金額の差 ④仕訳番号。金額が未入力なら ①③は全部同順位。
 * 上位 `RECEIPT_CANDIDATE_LIMIT` 件
 */
export function rankJournalCandidates(
  receipt: Pick<ReceiptRow, "transactionDate" | "amount">,
  journals: readonly CandidateJournal[],
  receivedDate: string,
): JournalCandidate[] {
  const base = receipt.transactionDate ?? receivedDate;
  const { amount } = receipt;
  const candidates: JournalCandidate[] = [];
  for (const j of journals) {
    if (j.status !== "active") continue;
    const daysDiff = Math.abs(daysBetween(base, j.date));
    if (daysDiff > RECEIPT_CANDIDATE_WINDOW_DAYS) continue;
    const total = j.lines.reduce((sum, l) => (l.side === "debit" ? sum + l.amount : sum), 0);
    candidates.push({
      journal: { id: j.id, journalNo: j.journalNo, date: j.date, status: j.status },
      total,
      daysDiff,
      amountMatches: amount !== null && total === amount,
    });
  }
  const amountGap = (c: JournalCandidate) => (amount === null ? 0 : Math.abs(c.total - amount));
  candidates.sort(
    (a, b) =>
      Number(b.amountMatches) - Number(a.amountMatches) ||
      a.daysDiff - b.daysDiff ||
      amountGap(a) - amountGap(b) ||
      a.journal.journalNo - b.journal.journalNo,
  );
  return candidates.slice(0, RECEIPT_CANDIDATE_LIMIT);
}
