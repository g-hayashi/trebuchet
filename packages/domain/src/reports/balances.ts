import type { PostedLine } from "../types.ts";
import { debitNet, isActive, type OpeningInput } from "./common.ts";

/** 科目・補助科目ごとの集計。opening・closing は借方を正とする */
export type Balance = {
  accountId: string;
  subAccountId: string | null;
  opening: number;
  debit: number;
  credit: number;
  closing: number;
};

export type BalancesInput = {
  opening: readonly OpeningInput[];
  lines: readonly PostedLine[];
  /** 会計期間の開始日。これより前の仕訳は含めない（収益・費用は会計期間ごとに 0 から始まる） */
  periodStart: string;
  /** 集計する期間の開始日（既定は periodStart）。periodStart〜前日の累計は opening に含める */
  from?: string | undefined;
  to: string;
};

/**
 * 科目・補助科目別の 期首・借方・貸方・期末 を集計する。
 * 取消済みの仕訳と、periodStart より前・to より後の仕訳は含めない（INV-6）
 */
export function computeBalances(input: BalancesInput): Balance[] {
  const from = input.from ?? input.periodStart;
  const map = new Map<string, Balance>();
  const get = (accountId: string, subAccountId: string | null) => {
    const key = `${accountId}\u0000${subAccountId ?? ""}`;
    let b = map.get(key);
    if (b === undefined) {
      b = { accountId, subAccountId, opening: 0, debit: 0, credit: 0, closing: 0 };
      map.set(key, b);
    }
    return b;
  };

  for (const o of input.opening) get(o.accountId, o.subAccountId ?? null).opening += debitNet(o);
  for (const l of input.lines) {
    if (!isActive(l) || l.date < input.periodStart || l.date > input.to) continue;
    const b = get(l.accountId, l.subAccountId);
    if (l.date < from) b.opening += debitNet(l);
    else if (l.side === "debit") b.debit += l.amount;
    else b.credit += l.amount;
  }
  return [...map.values()].map((b) => ({ ...b, closing: b.opening + b.debit - b.credit }));
}

/** 補助科目を合算して、科目ごとの集計にする */
export function balancesByAccount(balances: readonly Balance[]): Map<string, Balance> {
  const map = new Map<string, Balance>();
  for (const b of balances) {
    const sum = map.get(b.accountId);
    map.set(
      b.accountId,
      sum === undefined
        ? { ...b, subAccountId: null }
        : {
            ...sum,
            opening: sum.opening + b.opening,
            debit: sum.debit + b.debit,
            credit: sum.credit + b.credit,
            closing: sum.closing + b.closing,
          },
    );
  }
  return map;
}
