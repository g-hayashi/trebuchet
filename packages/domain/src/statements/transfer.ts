import type { StatementAccount } from "@trebuchet/schema";
import { daysBetween } from "../dates.ts";
import { type JournalDraft, ok, type Result, validation } from "../types.ts";
import { normalizeContent } from "./normalize.ts";

/** 振替（カードの引落・口座間の移動）の判定（006 R6、FR-019）。純関数 */

/** 対にする日付の幅（日） */
export const TRANSFER_WINDOW_DAYS = 7;

export type TransferStatement = {
  id: string;
  statementAccountId: string;
  date: string;
  /** 符号つき（入金が正） */
  amount: number;
};

/**
 * 候補を金額で索引にして、明細ごとの対の探索を「逆向きで同じ金額」の候補だけの走査にする。
 * 結果は `findTransferPair` と同じ。`excludedIds` にある ID の候補は対にしない（呼び出しの間に増えてよい。
 * 候補を作り直さずに、対にした明細を後から除くため）
 */
export function createTransferPairFinder<T extends TransferStatement>(
  candidates: readonly T[],
): (statement: TransferStatement, excludedIds?: ReadonlySet<string>) => T | undefined {
  const byAmount = new Map<number, T[]>();
  for (const c of candidates) {
    const bucket = byAmount.get(c.amount);
    if (bucket === undefined) byAmount.set(c.amount, [c]);
    else bucket.push(c);
  }

  return (statement, excludedIds) => {
    if (statement.amount === 0) return undefined;
    let best: T | undefined;
    let bestDiff = Number.POSITIVE_INFINITY;
    for (const c of byAmount.get(-statement.amount) ?? []) {
      if (
        c.id === statement.id ||
        c.statementAccountId === statement.statementAccountId ||
        excludedIds?.has(c.id) === true
      ) {
        continue;
      }
      const diff = Math.abs(daysBetween(statement.date, c.date));
      if (diff > TRANSFER_WINDOW_DAYS || diff >= bestDiff) continue;
      best = c;
      bestDiff = diff;
    }
    return best;
  };
}

/**
 * 対になる明細（反対の口座に、同じ金額で逆向き、日付が 7 日以内）を探す。
 * 複数あれば日付の差が最も小さいもの（同じなら `candidates` の先のもの）。自分自身・同じ口座・0 円は対にしない
 */
export function findTransferPair<T extends TransferStatement>(
  statement: TransferStatement,
  candidates: readonly T[],
): T | undefined {
  return createTransferPairFinder(candidates)(statement);
}

/** 振替の対の確信度。日付が離れるほど下がる（7 日でも 81） */
export const transferConfidence = (daysDiff: number): number => 95 - 2 * daysDiff;

export type TransferSide = {
  statement: { date: string; amount: number; content: string };
  account: Pick<StatementAccount, "accountId" | "subAccountId">;
};

/**
 * 2 つの口座の間の移動の仕訳の案（R6）: 借 入金の側の口座 / 貸 出金の側の口座。
 * 日付と摘要は出金の側の明細。引数の順は問わない。向きが同じ・金額が違う・科目のない口座は `VALIDATION`
 */
export function transferJournal(a: TransferSide, b: TransferSide): Result<JournalDraft> {
  const [out, inn] = a.statement.amount < 0 ? [a, b] : [b, a];
  if (out.statement.amount >= 0 || inn.statement.amount <= 0) {
    return validation("振替は出金と入金の組み合わせにしてください", { field: "amount" });
  }
  if (out.statement.amount !== -inn.statement.amount) {
    return validation("振替の金額が一致しません", { field: "amount" });
  }
  if (out.account.accountId == null || inn.account.accountId == null) {
    return validation("口座の科目が設定されていません", { field: "accountId" });
  }
  const amount = inn.statement.amount;
  const side = (
    s: "debit" | "credit",
    account: Pick<StatementAccount, "accountId" | "subAccountId">,
  ) => ({
    side: s,
    accountId: account.accountId as string,
    ...(account.subAccountId == null ? {} : { subAccountId: account.subAccountId }),
    amount,
    taxCategory: "OUT_OF_SCOPE" as const,
  });
  return ok({
    date: out.statement.date,
    memo: out.statement.content,
    lines: [side("debit", inn.account), side("credit", out.account)],
  });
}

export type UnpairedTransferGuess = { kind: "card_payment" } | { kind: "none" };

// 正規化（NFKC・大文字・空白除去）した内容に含まれる、カードの支払いらしい語
const CARD_WORDS = ["カード", "クレジット", "CARD", "VISA", "JCB", "MASTER", "AMEX", "DINERS"];

/**
 * 対のない引落（`transfer_flag` が立ち、対が見つからない出金）が、カードの支払いらしいかを内容から推定する。
 * どのカードかは決めない（ルール（R9）が決める）。ルールがなければ候補は作れず `none` のまま
 */
export function inferUnpairedTransfer(statement: {
  content: string;
  amount: number;
  transferFlag: boolean;
}): UnpairedTransferGuess {
  if (!statement.transferFlag || statement.amount >= 0) return { kind: "none" };
  const normalized = normalizeContent(statement.content);
  return CARD_WORDS.some((w) => normalized.includes(w))
    ? { kind: "card_payment" }
    : { kind: "none" };
}
