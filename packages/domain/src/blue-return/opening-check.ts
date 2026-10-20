import { type CarryForwardBalance, carryForward } from "../carry-forward.ts";
import { debitNet, type OpeningInput, sortAccounts } from "../reports/common.ts";
import { type Account, ok, type Result } from "../types.ts";

/**
 * 期首残高と前の年度の期末からの繰越の差（1 科目・補助科目）。金額は科目の通常の側を正とする符号つき。
 * diff = actual − expected（0 の行は返さない）
 */
export type OpeningMismatch = {
  accountId: string;
  subAccountId: string | null;
  /** 前の年度の期末から carryForward で求めた期首 */
  expected: number;
  /** 登録された期首残高 */
  actual: number;
  diff: number;
};

type Key = { accountId: string; subAccountId: string | null };

const keyOf = (k: Key) => JSON.stringify([k.accountId, k.subAccountId]);

/**
 * 元入金の繰越の検査（FR-029, R8）。前の年度の期末の残高に 002 の carryForward を適用した期首と、
 * 登録された期首残高を科目・補助科目ごとに比べる（002 の OPENING_DIFFERS_FROM_CARRY_FORWARD と同じ求め方）。
 * 期首の同じ科目・補助科目の行は合算する。並びは科目の順（sortOrder → コード）→ 補助科目なしが先 → 補助科目の ID。
 * carryForward が失敗したとき（元入金の科目がない）はそのエラーを返す
 */
export function checkOpeningCarryForward(
  priorClosing: readonly CarryForwardBalance[],
  opening: readonly OpeningInput[],
  accounts: readonly Account[],
): Result<OpeningMismatch[]> {
  const carried = carryForward(priorClosing, accounts);
  if (!carried.ok) return carried;

  const normalSide = new Map(accounts.map((a) => [a.id, a.normalSide]));
  const signed = (accountId: string, net: number) =>
    normalSide.get(accountId) === "credit" ? 0 - net : net;
  const totals = (rows: readonly OpeningInput[]) => {
    const m = new Map<string, Key & { amount: number }>();
    for (const r of rows) {
      const k: Key = { accountId: r.accountId, subAccountId: r.subAccountId ?? null };
      const prev = m.get(keyOf(k));
      if (prev === undefined) m.set(keyOf(k), { ...k, amount: debitNet(r) });
      else prev.amount += debitNet(r);
    }
    return m;
  };
  const expected = totals(carried.value);
  const actual = totals(opening);

  const keys = new Map<string, Key>();
  for (const [k, v] of [...expected, ...actual]) {
    keys.set(k, { accountId: v.accountId, subAccountId: v.subAccountId });
  }

  const order = new Map(sortAccounts([...accounts]).map((a, i) => [a.id, i]));
  const rank = (id: string) => order.get(id) ?? Number.MAX_SAFE_INTEGER;
  const mismatches: OpeningMismatch[] = [];
  for (const [k, key] of keys) {
    const e = signed(key.accountId, expected.get(k)?.amount ?? 0);
    const a = signed(key.accountId, actual.get(k)?.amount ?? 0);
    if (e === a) continue;
    mismatches.push({ ...key, expected: e, actual: a, diff: a - e });
  }
  mismatches.sort(
    (x, y) =>
      rank(x.accountId) - rank(y.accountId) ||
      compareIds(x.accountId, y.accountId) ||
      compareSubAccountIds(x.subAccountId, y.subAccountId),
  );
  return ok(mismatches);
}

const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function compareSubAccountIds(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return compareIds(a, b);
}
