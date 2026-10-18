import { describe, expect, it } from "vitest";
import { openingTotals } from "./opening-balances";

describe("openingTotals", () => {
  it("空なら 0 で一致", () => {
    expect(openingTotals([])).toEqual({ debit: 0, credit: 0, diff: 0, balanced: true });
  });

  it("借方と貸方を合計し、差額は借方 − 貸方", () => {
    const t = openingTotals([
      { side: "debit", amount: 100_000 },
      { side: "debit", amount: 50_000 },
      { side: "credit", amount: 120_000 },
    ]);
    expect(t).toEqual({ debit: 150_000, credit: 120_000, diff: 30_000, balanced: false });
  });

  it("一致すれば balanced", () => {
    const t = openingTotals([
      { side: "debit", amount: 300_000 },
      { side: "credit", amount: 200_000 },
      { side: "credit", amount: 100_000 },
    ]);
    expect(t.balanced).toBe(true);
    expect(t.diff).toBe(0);
  });

  it("未入力（undefined・NaN）の金額は 0 として数える", () => {
    const t = openingTotals([
      { side: "debit", amount: undefined },
      { side: "credit", amount: Number.NaN },
      { side: "debit", amount: 10 },
    ]);
    expect(t).toEqual({ debit: 10, credit: 0, diff: 10, balanced: false });
  });

  it("一致の判定は合計だけで行う（行ごとの検証はフォームのスキーマが行う）", () => {
    const t = openingTotals([
      { side: "debit", amount: 100 },
      { side: "credit", amount: 100 },
      { side: "debit", amount: undefined },
    ]);
    expect(t.balanced).toBe(true);
  });
});
