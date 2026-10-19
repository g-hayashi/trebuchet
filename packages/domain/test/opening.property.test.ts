import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type OpeningBalanceDraft, validateOpeningBalances } from "../src/opening.ts";
import { accountSetArb, amountArb, balancedOpeningArb } from "./arbitraries.ts";

const sum = (rows: readonly OpeningBalanceDraft[], side: "debit" | "credit") =>
  rows.filter((r) => r.side === side).reduce((s, r) => s + r.amount, 0);

/** 科目が重複しない、貸借がそろうとは限らない期首残高 */
const anyOpeningArb: fc.Arbitrary<OpeningBalanceDraft[]> = accountSetArb.chain((accounts) =>
  fc.shuffledSubarray(accounts).chain((picked) =>
    fc.tuple(
      ...picked.map((a) =>
        fc.record({
          accountId: fc.constant(a.id),
          side: fc.constantFrom<"debit" | "credit">("debit", "credit"),
          amount: amountArb,
        }),
      ),
    ),
  ),
);

describe("validateOpeningBalances（FR-011）", () => {
  it("貸借が一致する期首残高は成功する", () => {
    fc.assert(
      fc.property(accountSetArb.chain(balancedOpeningArb), (rows) => {
        const result = validateOpeningBalances(rows);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toHaveLength(rows.length);
        for (const r of result.value) expect(r.subAccountId).toBeNull();
      }),
    );
  });

  it("Σ借方 = Σ貸方 のときだけ成功し、失敗時は UNBALANCED と debit・credit・diff を返す", () => {
    fc.assert(
      fc.property(anyOpeningArb, (rows) => {
        const debit = sum(rows, "debit");
        const credit = sum(rows, "credit");
        const result = validateOpeningBalances(rows);
        expect(result.ok).toBe(debit === credit);
        if (result.ok) return;
        expect(result.error.code).toBe("UNBALANCED");
        expect(result.error.details).toEqual({ debit, credit, diff: debit - credit });
      }),
    );
  });

  it("一致する期首残高の1行の金額を変えると UNBALANCED になる", () => {
    fc.assert(
      fc.property(
        accountSetArb
          .chain(balancedOpeningArb)
          .chain((rows) => fc.tuple(fc.constant(rows), fc.nat(rows.length - 1))),
        fc.integer({ min: 1, max: 1_000_000 }),
        ([rows, i], delta) => {
          const changed = rows.map((r, j) => (j === i ? { ...r, amount: r.amount + delta } : r));
          const result = validateOpeningBalances(changed);
          expect(result.ok).toBe(false);
          if (result.ok) return;
          expect(result.error.code).toBe("UNBALANCED");
          expect(Math.abs(Number(result.error.details?.diff))).toBe(delta);
        },
      ),
    );
  });

  it("金額が 0 以下・整数でない・1兆円以上の行は VALIDATION で拒否する", () => {
    fc.assert(
      fc.property(
        accountSetArb
          .chain(balancedOpeningArb)
          .chain((rows) => fc.tuple(fc.constant(rows), fc.nat(rows.length - 1))),
        fc.oneof(
          fc.integer({ min: -1_000_000, max: 0 }),
          fc.double({ min: 0.01, max: 1e6, noNaN: true }).filter((n) => !Number.isInteger(n)),
          fc.constant(1e12),
        ),
        ([rows, i], bad) => {
          const changed = rows.map((r, j) => (j === i ? { ...r, amount: bad } : r));
          const result = validateOpeningBalances(changed);
          expect(result.ok).toBe(false);
          if (result.ok) return;
          expect(result.error.code).toBe("VALIDATION");
        },
      ),
    );
  });

  it("同じ（科目, 補助科目）の行の重複は VALIDATION で拒否する", () => {
    fc.assert(
      fc.property(
        accountSetArb
          .chain(balancedOpeningArb)
          .chain((rows) => fc.tuple(fc.constant(rows), fc.nat(rows.length - 1))),
        ([rows, i]) => {
          const dup = rows[i];
          if (dup === undefined) throw new Error("unreachable");
          // 貸借は一致させたまま、同じ科目の行を借方・貸方に1行ずつ足す
          const changed = [
            ...rows,
            { ...dup, side: "debit" as const, amount: 1 },
            { ...dup, side: "credit" as const, amount: 1 },
          ];
          const result = validateOpeningBalances(changed);
          expect(result.ok).toBe(false);
          if (result.ok) return;
          expect(result.error.code).toBe("VALIDATION");
        },
      ),
    );
  });

  it("同じ科目でも補助科目が異なれば重複ではない", () => {
    const result = validateOpeningBalances([
      { accountId: "a", subAccountId: "s1", side: "debit", amount: 100 },
      { accountId: "a", subAccountId: "s2", side: "debit", amount: 200 },
      { accountId: "a", side: "debit", amount: 300 },
      { accountId: "b", side: "credit", amount: 600 },
    ]);
    expect(result.ok).toBe(true);
  });

  it("subAccountId の undefined と null は同じ（補助科目なし）として重複を判定する", () => {
    const result = validateOpeningBalances([
      { accountId: "a", side: "debit", amount: 100 },
      { accountId: "a", subAccountId: null, side: "debit", amount: 100 },
      { accountId: "b", side: "credit", amount: 200 },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
  });

  it("空の期首残高は成功する（期首残高をすべて消す）", () => {
    expect(validateOpeningBalances([]).ok).toBe(true);
  });
});
