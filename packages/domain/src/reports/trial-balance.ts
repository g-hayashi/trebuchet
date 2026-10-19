import type { TrialBalance, TrialBalanceRow } from "@trebuchet/schema";
import type { Account, PostedLine } from "../types.ts";
import { balancesByAccount, computeBalances } from "./balances.ts";
import { type OpeningInput, reportAccount, sortAccounts, toSide } from "./common.ts";

export type TrialBalanceInput = {
  accounts: readonly Account[];
  opening: readonly OpeningInput[];
  lines: readonly PostedLine[];
  periodStart: string;
  from: string;
  to: string;
};

/**
 * 残高試算表（FR-028, INV-4）。期首・期末は科目の通常の側を正とする。
 * 期首・借方・貸方のいずれかが 0 でない科目を、決算書の科目順に並べる
 */
export function buildTrialBalance(input: TrialBalanceInput): TrialBalance {
  const balances = balancesByAccount(computeBalances(input));
  const rows: TrialBalanceRow[] = [];
  const totals = { debit: 0, credit: 0, closingDebit: 0, closingCredit: 0 };
  for (const account of sortAccounts([...input.accounts])) {
    const b = balances.get(account.id);
    if (b === undefined || (b.opening === 0 && b.debit === 0 && b.credit === 0)) continue;
    rows.push({
      ...reportAccount(account),
      opening: toSide(b.opening, account.normalSide),
      debit: b.debit,
      credit: b.credit,
      closing: toSide(b.closing, account.normalSide),
    });
    totals.debit += b.debit;
    totals.credit += b.credit;
    if (b.closing > 0) totals.closingDebit += b.closing;
    else totals.closingCredit -= b.closing;
  }
  return {
    kind: "trial-balance",
    from: input.from,
    to: input.to,
    rows,
    totals,
    balanced: totals.debit === totals.credit && totals.closingDebit === totals.closingCredit,
  };
}
