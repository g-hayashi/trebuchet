import type { ValidOpeningBalance } from "./opening.ts";
import type { Balance } from "./reports/balances.ts";
import { sortAccounts } from "./reports/common.ts";
import { type Account, domainError, err, ok, type Result } from "./types.ts";

/** 繰越で使う seed の科目のコード（research R6） */
export const CAPITAL_ACCOUNT_CODE = "3020";
export const OWNER_LOAN_ACCOUNT_CODE = "3010";
export const DRAWINGS_ACCOUNT_CODE = "3090";

/** 前年度の期末の残高（computeBalances の結果の一部。closing は借方を正とする） */
export type CarryForwardBalance = Pick<Balance, "accountId" | "subAccountId" | "closing">;

/**
 * 前年度の期末の残高から翌年度の期首残高の行を作る（FR-020a, research R6）。
 * 収益・費用（所得）と事業主借（3010）・事業主貸（3090）は元入金（3020、補助科目なし）に振り替えて 0 にし、
 * それ以外の科目・補助科目の残高はそのまま繰り越す。同じ科目・補助科目の行は合算し、0 の行は作らない。
 * 行の側は残高の符号で決め（借方を正）、並びは科目の順（sortOrder → コード）→ 補助科目なしが先 → 補助科目の ID。
 * 振り替える額があるのに元入金の科目がなければ VALIDATION
 */
export function carryForward(
  balances: readonly CarryForwardBalance[],
  accounts: readonly Account[],
): Result<ValidOpeningBalance[]> {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const capital = accounts.find((a) => a.code === CAPITAL_ACCOUNT_CODE);
  const closedCodes = [OWNER_LOAN_ACCOUNT_CODE, DRAWINGS_ACCOUNT_CODE];
  const isClosed = (a: Account | undefined) =>
    a !== undefined &&
    (a.category === "revenue" || a.category === "expense" || closedCodes.includes(a.code));

  const net = new Map<string, { accountId: string; subAccountId: string | null; amount: number }>();
  const add = (accountId: string, subAccountId: string | null, amount: number) => {
    const key = JSON.stringify([accountId, subAccountId]);
    const row = net.get(key);
    if (row === undefined) net.set(key, { accountId, subAccountId, amount });
    else row.amount += amount;
  };

  let transferred = 0;
  for (const b of balances) {
    if (isClosed(byId.get(b.accountId))) transferred += b.closing;
    else add(b.accountId, b.subAccountId, b.closing);
  }
  if (transferred !== 0) {
    if (capital === undefined) {
      return err(
        domainError("VALIDATION", "元入金の科目がないため、前年度の残高を繰り越せません", {
          code: CAPITAL_ACCOUNT_CODE,
        }),
      );
    }
    add(capital.id, null, transferred);
  }

  const order = new Map(sortAccounts([...accounts]).map((a, i) => [a.id, i]));
  const rank = (id: string) => order.get(id) ?? Number.MAX_SAFE_INTEGER;
  const rows = [...net.values()]
    .filter((r) => r.amount !== 0)
    .sort(
      (a, b) =>
        rank(a.accountId) - rank(b.accountId) ||
        (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0) ||
        compareSubAccountIds(a.subAccountId, b.subAccountId),
    );
  return ok(
    rows.map((r) => ({
      accountId: r.accountId,
      subAccountId: r.subAccountId,
      side: r.amount > 0 ? "debit" : "credit",
      amount: Math.abs(r.amount),
    })),
  );
}

function compareSubAccountIds(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : 1;
}
