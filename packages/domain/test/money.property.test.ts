import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { computeInclusiveTax, sumYen, toYen } from "../src/money.ts";

const amountArb = fc.integer({ min: 1, max: 1e12 - 1 });
const rateArb = fc.constantFrom(8, 10);

describe("computeInclusiveTax (INV-10)", () => {
  it("内税額 = floor(amount * rate / (100 + rate))", () => {
    fc.assert(
      fc.property(amountArb, rateArb, (amount, rate) => {
        const tax = computeInclusiveTax(amount, rate);
        // BigInt で厳密に検証する
        const exact = (BigInt(amount) * BigInt(rate)) / BigInt(100 + rate);
        expect(BigInt(tax)).toBe(exact);
      }),
    );
  });

  it("0 <= tax < amount かつ安全な整数", () => {
    fc.assert(
      fc.property(amountArb, rateArb, (amount, rate) => {
        const tax = computeInclusiveTax(amount, rate);
        expect(Number.isSafeInteger(tax)).toBe(true);
        expect(tax).toBeGreaterThanOrEqual(0);
        expect(tax).toBeLessThan(amount);
      }),
    );
  });

  it("具体例: 11,000 円（10%）の内税は 1,000 円、1,080 円（8%）は 80 円", () => {
    expect(computeInclusiveTax(11_000, 10)).toBe(1_000);
    expect(computeInclusiveTax(1_080, 8)).toBe(80);
    expect(computeInclusiveTax(1, 10)).toBe(0);
  });
});

describe("sumYen", () => {
  const valuesArb = fc.array(amountArb, { maxLength: 50 });

  it("結合的で、順序に依存しない", () => {
    fc.assert(
      fc.property(valuesArb, valuesArb, (a, b) => {
        expect(sumYen([...a, ...b])).toBe(sumYen(a) + sumYen(b));
        expect(sumYen([...a].reverse())).toBe(sumYen(a));
      }),
    );
  });

  it("結果は安全な整数", () => {
    fc.assert(
      fc.property(valuesArb, (values) => {
        expect(Number.isSafeInteger(sumYen(values))).toBe(true);
      }),
    );
  });

  it("空配列は 0", () => {
    expect(sumYen([])).toBe(0);
  });

  it("安全な整数を超える場合は例外", () => {
    expect(() => sumYen([Number.MAX_SAFE_INTEGER, 1])).toThrow(RangeError);
  });
});

describe("toYen", () => {
  it("正の整数で 1e12 未満なら ok", () => {
    fc.assert(
      fc.property(amountArb, (n) => {
        const r = toYen(n);
        expect(r.ok).toBe(true);
      }),
    );
  });

  it.each([0, -1, 1.5, 1e12, Number.NaN, Number.POSITIVE_INFINITY])("%s は VALIDATION", (n) => {
    const r = toYen(n);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("VALIDATION");
  });
});
