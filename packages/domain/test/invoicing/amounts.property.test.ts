import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { hoursToHalves, itemAmount, taxBreakdown } from "../../src/invoicing/amounts.ts";

// INV-37（data-model §4、R7）

const halvesArb = fc.integer({ min: 1, max: 100_000 });
const priceArb = fc.integer({ min: 1, max: 1_000_000 });

describe("itemAmount (INV-37)", () => {
  it("floor(halves × price / 2)（BigInt で厳密に検証）", () => {
    fc.assert(
      fc.property(halvesArb, priceArb, (halves, price) => {
        const amount = itemAmount(halves, price);
        expect(Number.isSafeInteger(amount)).toBe(true);
        expect(BigInt(amount)).toBe((BigInt(halves) * BigInt(price)) / 2n);
      }),
    );
  });

  it("US1 Acceptance 1: 120.5 時間 × 10,000 円 = 1,205,000 円", () => {
    expect(itemAmount(hoursToHalves(120.5), 10_000)).toBe(1_205_000);
  });

  it("Edge Case: 0.5 時間 × 10,001 円 = 5,000 円（切り捨て）", () => {
    expect(itemAmount(hoursToHalves(0.5), 10_001)).toBe(5_000);
  });
});

describe("hoursToHalves", () => {
  it("0.5 の倍数を半時間の整数にする", () => {
    expect(hoursToHalves(0)).toBe(0);
    expect(hoursToHalves(0.5)).toBe(1);
    expect(hoursToHalves(120.5)).toBe(241);
  });

  it("0.5 の倍数でない・負の値は RangeError", () => {
    expect(() => hoursToHalves(1.25)).toThrow(RangeError);
    expect(() => hoursToHalves(-0.5)).toThrow(RangeError);
    expect(() => hoursToHalves(Number.NaN)).toThrow(RangeError);
  });

  it("任意の 0.5 の倍数で往復できる", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000 }), (h) => {
        expect(hoursToHalves(h / 2)).toBe(h);
      }),
    );
  });
});

describe("taxBreakdown (INV-37)", () => {
  const itemArb = fc.record({
    amount: fc.integer({ min: 1, max: 99_999_999 }),
    taxRate: fc.constantFrom<number | null>(8, 10, null),
  });

  it("税率ごとに exclusive + tax = inclusive、すべて整数、tax は floor(合計 × r / (100 + r))", () => {
    fc.assert(
      fc.property(fc.array(itemArb, { minLength: 1, maxLength: 5 }), (items) => {
        const rows = taxBreakdown(items);
        const rates = new Set(items.map((i) => i.taxRate));
        expect(rows).toHaveLength(rates.size);
        for (const row of rows) {
          const inclusive = items
            .filter((i) => i.taxRate === row.rate)
            .reduce((s, i) => s + i.amount, 0);
          expect(row.inclusive).toBe(inclusive);
          expect(Number.isInteger(row.tax)).toBe(true);
          expect(Number.isInteger(row.exclusive)).toBe(true);
          expect(row.exclusive + row.tax).toBe(row.inclusive);
          const expected =
            row.rate === null ? 0 : Math.floor((inclusive * row.rate) / (100 + row.rate));
          expect(row.tax).toBe(expected);
        }
      }),
    );
  });

  it("税率なしは税額 0（税抜 = 税込）", () => {
    expect(taxBreakdown([{ amount: 1000, taxRate: null }])).toEqual([
      { rate: null, inclusive: 1000, tax: 0, exclusive: 1000 },
    ]);
  });

  it("税率ごとに1回だけ切り捨てる（明細ごとに切り捨てない）", () => {
    // 21 円 × 2 行: 明細ごとなら floor(21 × 10 / 110) = 1 が 2 行で 2、税率ごとに1回なら floor(42 × 10 / 110) = 3
    expect(
      taxBreakdown([
        { amount: 21, taxRate: 10 },
        { amount: 21, taxRate: 10 },
      ]),
    ).toEqual([{ rate: 10, inclusive: 42, tax: 3, exclusive: 39 }]);
  });

  it("税率の高い順、税率なしは最後", () => {
    const rows = taxBreakdown([
      { amount: 100, taxRate: null },
      { amount: 108, taxRate: 8 },
      { amount: 110, taxRate: 10 },
    ]);
    expect(rows.map((r) => r.rate)).toEqual([10, 8, null]);
  });

  it("空なら空", () => {
    expect(taxBreakdown([])).toEqual([]);
  });
});
