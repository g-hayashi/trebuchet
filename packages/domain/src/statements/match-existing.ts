import type { StatementAccount } from "@trebuchet/schema";
import { daysBetween } from "../dates.ts";
import type { Journal } from "../types.ts";

/** 既存の仕訳との照合（006 R7、FR-021a）。純関数 */

/** 照合する日付の幅（日） */
export const MATCH_WINDOW_DAYS = 7;

/** 照合の確信度。日付が離れるほど下がる（0 日で 95、7 日で 60） */
export const matchConfidence = (daysDiff: number): number => 95 - 5 * daysDiff;

export type ExistingMatch = {
  journalId: string;
  lineId: string;
  /** 明細の日付と仕訳の日付の差の絶対値（日） */
  daysDiff: number;
  confidence: number;
};

/**
 * 明細の口座の科目・補助科目に、同じ向き（入金は借方、出金は貸方）・同じ金額の行を持つ有効な仕訳で、
 * 日付の差が 7 日以内、まだ明細に結びついていない行を探す。複数あれば日付の差が最も小さいもの
 * （同じなら仕訳番号の小さい方）。取消済みの仕訳・結びつき済みの行・科目のない口座・0 円は対象外
 */
export function matchExistingJournal(
  statement: { date: string; amount: number },
  account: Pick<StatementAccount, "accountId" | "subAccountId">,
  journals: readonly Journal[],
  linkedLineIds: ReadonlySet<string>,
): ExistingMatch | undefined {
  if (account.accountId == null || statement.amount === 0) return undefined;
  const side = statement.amount > 0 ? "debit" : "credit";
  const amount = Math.abs(statement.amount);

  let best: (ExistingMatch & { journalNo: number }) | undefined;
  for (const j of journals) {
    if (j.status !== "active") continue;
    const daysDiff = Math.abs(daysBetween(statement.date, j.date));
    if (daysDiff > MATCH_WINDOW_DAYS) continue;
    if (
      best !== undefined &&
      (daysDiff > best.daysDiff || (daysDiff === best.daysDiff && j.journalNo >= best.journalNo))
    ) {
      continue;
    }
    const line = j.lines.find(
      (l) =>
        l.side === side &&
        l.amount === amount &&
        l.accountId === account.accountId &&
        l.subAccountId === (account.subAccountId ?? null) &&
        !linkedLineIds.has(l.id),
    );
    if (line === undefined) continue;
    best = {
      journalId: j.id,
      lineId: line.id,
      daysDiff,
      confidence: matchConfidence(daysDiff),
      journalNo: j.journalNo,
    };
  }
  if (best === undefined) return undefined;
  const { journalNo: _journalNo, ...match } = best;
  return match;
}
