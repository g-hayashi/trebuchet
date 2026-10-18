import { isYen, sumYen } from "./money.ts";
import { domainError, err, ok, type Result, type Side } from "./types.ts";

/** 期首残高の入力の1行 */
export type OpeningBalanceDraft = {
  accountId: string;
  subAccountId?: string | null | undefined;
  side: Side;
  amount: number;
};

/** 検証済みの期首残高の行（補助科目なしは null） */
export type ValidOpeningBalance = {
  accountId: string;
  subAccountId: string | null;
  side: Side;
  amount: number;
};

/**
 * 期首残高を検証する（FR-011）。
 * 金額が 1 円以上 1 兆円未満の整数で、(科目, 補助科目) が重複せず、Σ借方 = Σ貸方 のときだけ成功する。
 */
export function validateOpeningBalances(
  rows: readonly OpeningBalanceDraft[],
): Result<ValidOpeningBalance[]> {
  const seen = new Set<string>();
  const valid: ValidOpeningBalance[] = [];
  for (const [index, row] of rows.entries()) {
    if (!isYen(row.amount)) {
      return err(
        domainError("VALIDATION", "金額は 1 円以上 1 兆円未満の整数で入力してください", {
          index,
          amount: row.amount,
        }),
      );
    }
    const subAccountId = row.subAccountId ?? null;
    const key = JSON.stringify([row.accountId, subAccountId]);
    if (seen.has(key)) {
      return err(
        domainError("VALIDATION", "同じ科目・補助科目の行が重複しています", {
          index,
          accountId: row.accountId,
          subAccountId,
        }),
      );
    }
    seen.add(key);
    valid.push({ accountId: row.accountId, subAccountId, side: row.side, amount: row.amount });
  }

  const debit = sumYen(valid.filter((r) => r.side === "debit").map((r) => r.amount));
  const credit = sumYen(valid.filter((r) => r.side === "credit").map((r) => r.amount));
  if (debit !== credit) {
    return err(
      domainError("UNBALANCED", "期首残高の借方合計と貸方合計が一致しません", {
        debit,
        credit,
        diff: debit - credit,
      }),
    );
  }
  return ok(valid);
}
