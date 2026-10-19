import type { Account, DomainWarning } from "../types.ts";
import { type Balance, balancesByAccount } from "./balances.ts";
import { sortAccounts, toSide } from "./common.ts";

export type WarningContext = {
  fiscalYear: number;
  /** 会計期間の期首残高が登録されているか */
  openingRegistered: boolean;
};

/** 帳票の金額の表示（3桁区切り、マイナスは ▲） */
export const formatSignedAmount = (amount: number) =>
  amount < 0 ? `▲${(-amount).toLocaleString("ja-JP")}` : amount.toLocaleString("ja-JP");

/**
 * 帳票の警告（FR-033, Edge Cases）。期首残高の未登録を先頭に、
 * 資産・負債の科目で残高（科目の合計、通常の側を正）がマイナスのものを科目順に出す
 */
export function detectWarnings(
  balances: readonly Balance[],
  accounts: readonly Account[],
  context?: WarningContext,
): DomainWarning[] {
  const warnings: DomainWarning[] = [];
  if (context !== undefined && !context.openingRegistered) {
    warnings.push({
      code: "OPENING_BALANCE_MISSING",
      message: `${context.fiscalYear}年度の期首残高が未登録です`,
      details: { fiscalYear: context.fiscalYear },
    });
  }
  const byAccount = balancesByAccount(balances);
  for (const account of sortAccounts([...accounts])) {
    if (account.category !== "asset" && account.category !== "liability") continue;
    const closing = byAccount.get(account.id)?.closing;
    if (closing === undefined) continue;
    const balance = toSide(closing, account.normalSide);
    if (balance >= 0) continue;
    warnings.push({
      code: "NEGATIVE_BALANCE",
      message: `${account.name}の残高がマイナス（${formatSignedAmount(balance)}）です`,
      details: { accountId: account.id, accountName: account.name, balance },
    });
  }
  return warnings;
}
