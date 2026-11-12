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

export type ExistingJournalMatcher = (
  statement: { date: string; amount: number },
  account: Pick<StatementAccount, "accountId" | "subAccountId">,
  linkedLineIds: ReadonlySet<string>,
) => ExistingMatch | undefined;

type IndexedLine = { journal: Journal; lineId: string };

const lineKey = (
  side: string,
  accountId: string,
  subAccountId: string | null,
  amount: number,
): string => JSON.stringify([side, accountId, subAccountId, amount]);

/**
 * 仕訳を（向き・科目・補助科目・金額）で索引にして、明細ごとの照合を同じ行を持つ仕訳だけの走査にする。
 * 結果は `matchExistingJournal` と同じ。索引は有効な仕訳の行だけを、仕訳・行の順に持つ。
 * `linkedLineIds` は照合のたびに読む（呼び出しの間に増えてよい）
 */
export function createExistingJournalMatcher(journals: readonly Journal[]): ExistingJournalMatcher {
  const byKey = new Map<string, IndexedLine[]>();
  for (const journal of journals) {
    if (journal.status !== "active") continue;
    for (const l of journal.lines) {
      const key = lineKey(l.side, l.accountId, l.subAccountId, l.amount);
      const bucket = byKey.get(key);
      const entry = { journal, lineId: l.id };
      if (bucket === undefined) byKey.set(key, [entry]);
      else bucket.push(entry);
    }
  }

  return (statement, account, linkedLineIds) => {
    if (account.accountId == null || statement.amount === 0) return undefined;
    const side = statement.amount > 0 ? "debit" : "credit";
    const bucket = byKey.get(
      lineKey(side, account.accountId, account.subAccountId ?? null, Math.abs(statement.amount)),
    );
    if (bucket === undefined) return undefined;

    let best: (ExistingMatch & { journalNo: number }) | undefined;
    for (const { journal, lineId } of bucket) {
      if (linkedLineIds.has(lineId)) continue;
      const daysDiff = Math.abs(daysBetween(statement.date, journal.date));
      if (daysDiff > MATCH_WINDOW_DAYS) continue;
      if (
        best !== undefined &&
        (daysDiff > best.daysDiff ||
          (daysDiff === best.daysDiff && journal.journalNo >= best.journalNo))
      ) {
        continue;
      }
      best = {
        journalId: journal.id,
        lineId,
        daysDiff,
        confidence: matchConfidence(daysDiff),
        journalNo: journal.journalNo,
      };
    }
    if (best === undefined) return undefined;
    const { journalNo: _journalNo, ...match } = best;
    return match;
  };
}

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
  return createExistingJournalMatcher(journals)(statement, account, linkedLineIds);
}
