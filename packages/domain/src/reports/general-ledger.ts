import type { GeneralLedger, GeneralLedgerEntry } from "@trebuchet/schema";
import type { Account, PostedLine } from "../types.ts";
import {
  compareLines,
  debitNet,
  isActive,
  type OpeningInput,
  reportAccount,
  toSide,
} from "./common.ts";

export type GeneralLedgerInput = {
  accounts: readonly Account[];
  opening: readonly OpeningInput[];
  lines: readonly PostedLine[];
  periodStart: string;
  from: string;
  to: string;
  accountId: string;
  /** 指定すると、その補助科目の期首残高と行だけで計算する */
  subAccount: { id: string; name: string } | null;
};

/** 相手科目の名前。相手側の科目が 1 つならその科目、複数なら「諸口」 */
export const MIXED_COUNTERPART = "諸口";

/**
 * 総勘定元帳（FR-027）: 前期繰越から、日付 → 仕訳番号の順に取引と残高（科目の通常の側を正）の推移を出す
 */
export function buildGeneralLedger(input: GeneralLedgerInput): GeneralLedger {
  const account = input.accounts.find((a) => a.id === input.accountId);
  if (account === undefined) throw new Error(`科目がありません: ${input.accountId}`);
  const side = account.normalSide;
  const subId = input.subAccount?.id;
  const matches = (l: { accountId: string; subAccountId?: string | null | undefined }) =>
    l.accountId === account.id && (subId === undefined || l.subAccountId === subId);

  let broughtForward = 0;
  for (const o of input.opening) if (matches(o)) broughtForward += toSide(debitNet(o), side);

  const inRange: PostedLine[] = [];
  for (const l of input.lines) {
    if (!isActive(l) || !matches(l) || l.date < input.periodStart || l.date > input.to) continue;
    if (l.date < input.from) broughtForward += toSide(debitNet(l), side);
    else inRange.push(l);
  }
  inRange.sort(compareLines);

  const journalIds = new Set(inRange.map((l) => l.journalId));
  const journalLines = new Map<string, PostedLine[]>();
  for (const l of input.lines) {
    if (!isActive(l) || !journalIds.has(l.journalId)) continue;
    const list = journalLines.get(l.journalId);
    if (list === undefined) journalLines.set(l.journalId, [l]);
    else list.push(l);
  }
  const counterpart = (l: PostedLine) => {
    const names = new Set(
      (journalLines.get(l.journalId) ?? [])
        .filter((x) => x.side !== l.side)
        .map((x) => x.accountName),
    );
    return names.size === 1 ? ([...names][0] ?? MIXED_COUNTERPART) : MIXED_COUNTERPART;
  };

  let balance = broughtForward;
  const totals = { debit: 0, credit: 0 };
  const entries = inRange.map((l): GeneralLedgerEntry => {
    balance += toSide(debitNet(l), side);
    totals[l.side] += l.amount;
    return {
      journalId: l.journalId,
      journalNo: l.journalNo,
      date: l.date,
      lineNo: l.lineNo,
      counterpart: counterpart(l),
      description: l.description ?? l.memo,
      debit: l.side === "debit" ? l.amount : 0,
      credit: l.side === "credit" ? l.amount : 0,
      balance,
    };
  });

  return {
    kind: "general-ledger",
    from: input.from,
    to: input.to,
    account: reportAccount(account),
    subAccount: input.subAccount,
    broughtForward,
    entries,
    totals,
    closing: balance,
  };
}
