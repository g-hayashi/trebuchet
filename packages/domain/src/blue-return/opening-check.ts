import { type CarryForwardBalance, carryForward } from "../carry-forward.ts";
import { debitNet, type OpeningInput, sortAccounts } from "../reports/common.ts";
import { type Account, ok, type Result } from "../types.ts";

/**
 * 期首残高と前の年度の期末からの繰越の差（1 勘定科目）。金額は科目の通常の側を正とする符号つき。
 * diff = actual − expected（0 の行は返さない）
 */
export type OpeningMismatch = {
  accountId: string;
  /** 前の年度の期末から carryForward で求めた期首 */
  expected: number;
  /** 登録された期首残高 */
  actual: number;
  diff: number;
};

/**
 * 元入金の繰越の検査（FR-029, R8）。前の年度の期末の残高に 002 の carryForward を適用した期首と、
 * 登録された期首残高を勘定科目ごとに比べる。補助科目は合算する
 * （補助科目の付け方の違いだけでは差にしない。決算書は勘定科目の合計で作るため）。
 * 並びは科目の順（sortOrder → コード）。
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
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.accountId, (m.get(r.accountId) ?? 0) + debitNet(r));
    return m;
  };
  const expected = totals(carried.value);
  const actual = totals(opening);

  const ids = new Set([...expected.keys(), ...actual.keys()]);
  const order = new Map(sortAccounts([...accounts]).map((a, i) => [a.id, i]));
  const rank = (id: string) => order.get(id) ?? Number.MAX_SAFE_INTEGER;
  const mismatches: OpeningMismatch[] = [];
  for (const accountId of ids) {
    const e = signed(accountId, expected.get(accountId) ?? 0);
    const a = signed(accountId, actual.get(accountId) ?? 0);
    if (e === a) continue;
    mismatches.push({ accountId, expected: e, actual: a, diff: a - e });
  }
  mismatches.sort(
    (x, y) => rank(x.accountId) - rank(y.accountId) || compareIds(x.accountId, y.accountId),
  );
  return ok(mismatches);
}

const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
