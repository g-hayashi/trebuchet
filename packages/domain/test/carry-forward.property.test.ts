import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type CarryForwardBalance, carryForward } from "../src/carry-forward.ts";
import type { Account } from "../src/types.ts";
import { ACCOUNTS, accountId } from "./import/import-setup.ts";

const CAPITAL = accountId("3020");
const OWNER_LOAN = accountId("3010");
const DRAWINGS = accountId("3090");
const byId = new Map(ACCOUNTS.map((a) => [a.id, a]));
const isPl = (id: string) => {
  const c = byId.get(id)?.category;
  return c === "revenue" || c === "expense";
};
/** 元入金に振り替えて 0 にする科目 */
const isClosed = (id: string) => isPl(id) || id === OWNER_LOAN || id === DRAWINGS;

const keyOf = (b: { accountId: string; subAccountId: string | null }) =>
  `${b.accountId}\u0000${b.subAccountId ?? ""}`;
const debitNet = (r: { side: "debit" | "credit"; amount: number }) =>
  r.side === "debit" ? r.amount : -r.amount;

/** 科目・補助科目が重複せず、Σ期末（借方を正）= 0 の前年度の期末残高（computeBalances の形） */
const balancedClosingArb: fc.Arbitrary<CarryForwardBalance[]> = fc
  .uniqueArray(
    fc.record({
      accountId: fc.constantFrom(...ACCOUNTS.map((a) => a.id)),
      subAccountId: fc.option(fc.constantFrom("sub-1", "sub-2"), { nil: null }),
      closing: fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
    }),
    { minLength: 1, maxLength: 30, selector: keyOf },
  )
  .map((rows) => {
    const sum = rows.reduce((s, r) => s + r.closing, 0);
    return rows.map((r, i) => (i === 0 ? { ...r, closing: r.closing - sum } : r));
  });

const netByKey = (
  rows: readonly {
    accountId: string;
    subAccountId: string | null;
    side: "debit" | "credit";
    amount: number;
  }[],
) => {
  const m = new Map<string, number>();
  for (const r of rows) m.set(keyOf(r), (m.get(keyOf(r)) ?? 0) + debitNet(r));
  return m;
};

function carried(
  balances: readonly CarryForwardBalance[],
  accounts: readonly Account[] = ACCOUNTS,
) {
  const r = carryForward(balances, accounts);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

describe("carryForward（T036, research R6, FR-020a）", () => {
  it("(1) 貸借が一致する期末残高から作った期首は貸借が一致し、金額はすべて正で科目・補助科目が重複しない", () => {
    fc.assert(
      fc.property(balancedClosingArb, (balances) => {
        const rows = carried(balances);
        const sum = (side: "debit" | "credit") =>
          rows.filter((r) => r.side === side).reduce((s, r) => s + r.amount, 0);
        expect(sum("debit")).toBe(sum("credit"));
        for (const r of rows) expect(r.amount).toBeGreaterThan(0);
        expect(new Set(rows.map(keyOf)).size).toBe(rows.length);
      }),
    );
  });

  it("(2) 収益・費用・事業主貸（3090）・事業主借（3010）は 0（行を作らない）", () => {
    fc.assert(
      fc.property(balancedClosingArb, (balances) => {
        for (const r of carried(balances)) expect(isClosed(r.accountId)).toBe(false);
      }),
    );
  });

  it("(3) 元入金（3020）= 元入金 ＋ 所得 ＋ 事業主借 − 事業主貸", () => {
    fc.assert(
      fc.property(balancedClosingArb, (balances) => {
        const credit = (pred: (b: CarryForwardBalance) => boolean) =>
          balances.filter(pred).reduce((s, b) => s - b.closing, 0);
        const capital = credit((b) => b.accountId === CAPITAL && b.subAccountId === null);
        const income = credit((b) => isPl(b.accountId));
        const ownerLoan = credit((b) => b.accountId === OWNER_LOAN);
        const drawings = -credit((b) => b.accountId === DRAWINGS);
        const after =
          netByKey(carried(balances)).get(keyOf({ accountId: CAPITAL, subAccountId: null })) ?? 0;
        expect(0 - after).toBe(capital + income + ownerLoan - drawings + 0);
      }),
    );
  });

  it("(4) 資産・負債の科目と補助科目の残高は変わらない", () => {
    fc.assert(
      fc.property(balancedClosingArb, (balances) => {
        const after = netByKey(carried(balances));
        for (const b of balances) {
          if (isClosed(b.accountId)) continue;
          if (b.accountId === CAPITAL && b.subAccountId === null) continue;
          expect(after.get(keyOf(b)) ?? 0).toBe(b.closing);
        }
      }),
    );
  });

  // research R5 の例の資産は貸借が合うよう「事業主貸を除いて 1,400」とした（R5 の本文の 1,100 では一致しない）
  it("research R5 の合成の例: 元入金 1,000 ほか → 元入金 1,400、事業主借・事業主貸・損益は 0", () => {
    const rows = carried([
      { accountId: accountId("1020"), subAccountId: null, closing: 1_400 },
      { accountId: DRAWINGS, subAccountId: null, closing: 300 },
      { accountId: OWNER_LOAN, subAccountId: null, closing: -100 },
      { accountId: CAPITAL, subAccountId: null, closing: -1_000 },
      { accountId: accountId("4010"), subAccountId: null, closing: -900 },
      { accountId: accountId("5170"), subAccountId: null, closing: 300 },
    ]);
    expect(rows).toEqual([
      { accountId: accountId("1020"), subAccountId: null, side: "debit", amount: 1_400 },
      { accountId: CAPITAL, subAccountId: null, side: "credit", amount: 1_400 },
    ]);
  });

  it("マイナスの残高は反対側の行になる。行は科目の並び順", () => {
    const rows = carried([
      { accountId: CAPITAL, subAccountId: null, closing: 0 },
      { accountId: accountId("1030"), subAccountId: null, closing: -500 },
      { accountId: accountId("1010"), subAccountId: null, closing: 500 },
    ]);
    expect(rows).toEqual([
      { accountId: accountId("1010"), subAccountId: null, side: "debit", amount: 500 },
      { accountId: accountId("1030"), subAccountId: null, side: "credit", amount: 500 },
    ]);
  });

  it("元入金の科目がなく、振り替える額があるときは VALIDATION", () => {
    const accounts = ACCOUNTS.filter((a) => a.code !== "3020");
    const r = carryForward(
      [
        { accountId: accountId("1010"), subAccountId: null, closing: 500 },
        { accountId: accountId("4010"), subAccountId: null, closing: -500 },
      ],
      accounts,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("VALIDATION");
    const none = carryForward(
      [{ accountId: accountId("1010"), subAccountId: null, closing: 0 }],
      accounts,
    );
    expect(none).toEqual({ ok: true, value: [] });
  });
});
