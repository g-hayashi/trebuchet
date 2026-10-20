import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { blueDeduction, blueDeductionCap } from "../../src/blue-return/deduction.ts";
import { TAX_PARAMETERS } from "../../src/seed/tax-parameters.ts";

const DATE = "2025-12-31";
const MAX = 650_000;
const STANDARD = 550_000;
const BASIC = 100_000;

const answersFromBits = (bits: number) => ({
  doubleEntry: (bits & 1) !== 0,
  statementsAttached: (bits & 2) !== 0,
  filedOnTime: (bits & 4) !== 0,
  eTax: (bits & 8) !== 0,
  electronicBooks: (bits & 16) !== 0,
});

describe("blueDeductionCap（R9）", () => {
  it("回答なし（undefined / null）は undefined", () => {
    expect(blueDeductionCap(undefined, DATE, TAX_PARAMETERS)).toBeUndefined();
    expect(blueDeductionCap(null, DATE, TAX_PARAMETERS)).toBeUndefined();
  });

  it("回答の組み合わせ5ビットの全32通りで tier・上限額・unmet が決まる", () => {
    for (let bits = 0; bits < 32; bits++) {
      const a = answersFromBits(bits);
      const result = blueDeductionCap(a, DATE, TAX_PARAMETERS);
      expect(result, `bits=${bits}`).toBeDefined();
      const first3 = a.doubleEntry && a.statementsAttached && a.filedOnTime;
      const either = a.eTax || a.electronicBooks;
      const tier = first3 && either ? "max" : first3 ? "standard" : "basic";
      expect(result?.tier, `bits=${bits}`).toBe(tier);
      expect(result?.cap, `bits=${bits}`).toBe(
        tier === "max" ? MAX : tier === "standard" ? STANDARD : BASIC,
      );
      // unmet は最上位（max）に足りない要件の数: 前の3つの偽の数 + (e-Tax も電子帳簿も偽なら 1)
      const expectedCount =
        [a.doubleEntry, a.statementsAttached, a.filedOnTime].filter((v) => !v).length +
        (either ? 0 : 1);
      expect(result?.unmet, `bits=${bits}`).toHaveLength(expectedCount);
      expect(new Set(result?.unmet).size, `bits=${bits}`).toBe(expectedCount);
      if (tier === "max") expect(result?.unmet).toEqual([]);
      for (const u of result?.unmet ?? []) expect(u.length).toBeGreaterThan(0);
    }
  });

  it("DeductionAnswers（fiscalYear・updatedAt つき）も受け取れる", () => {
    const answers = {
      fiscalYear: 2025,
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...answersFromBits(31),
    };
    expect(blueDeductionCap(answers, DATE, TAX_PARAMETERS)?.tier).toBe("max");
  });

  it("税制の値がなければエラー", () => {
    expect(() => blueDeductionCap(answersFromBits(31), DATE, [])).toThrow();
  });
});

describe("blueDeduction（INV-22）", () => {
  it("0 ≤ 控除額 ≤ 上限額、かつ = min(上限額, max(0, 欄43))", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5_000_000 }),
        fc.integer({ min: -5_000_000, max: 20_000_000 }),
        (cap, income) => {
          const d = blueDeduction(cap, income);
          expect(d).toBeGreaterThanOrEqual(0);
          expect(d).toBeLessThanOrEqual(cap);
          expect(d).toBe(Math.min(cap, Math.max(0, income)));
          expect(Number.isInteger(d)).toBe(true);
          expect(Object.is(d, -0)).toBe(false);
        },
      ),
    );
  });

  it("境界: 欄43 が負なら 0、上限ちょうどなら上限", () => {
    expect(blueDeduction(MAX, -1)).toBe(0);
    expect(blueDeduction(MAX, 0)).toBe(0);
    expect(blueDeduction(MAX, MAX)).toBe(MAX);
    expect(blueDeduction(MAX, MAX - 1)).toBe(MAX - 1);
    expect(blueDeduction(MAX, MAX + 1)).toBe(MAX);
  });
});
