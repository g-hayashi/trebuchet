import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { withholdingBase, withholdingTax } from "../../src/invoicing/withholding.ts";
import { TAX_PARAMETERS } from "../../src/seed/tax-parameters.ts";
import type { TaxParameter } from "../../src/types.ts";

// INV-73（data-model §4、research R1・R3）

const DATE = "2026-06-15";
const T = 1_000_000;
const L = 1021;
const H = 2042;

const taxOf = (base: number, date = DATE, params: readonly TaxParameter[] = TAX_PARAMETERS) => {
  const r = withholdingTax(base, date, params);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

const baseArb = fc.integer({ min: 1, max: 999_999_999_999 });

describe("withholdingTax (INV-73)", () => {
  it("0 ≤ tax ≤ base の整数", () => {
    fc.assert(
      fc.property(baseArb, (base) => {
        const tax = taxOf(base);
        expect(Number.isSafeInteger(tax)).toBe(true);
        expect(tax).toBeGreaterThanOrEqual(0);
        expect(tax).toBeLessThanOrEqual(base);
      }),
    );
  });

  it("base について単調増加（非減少）", () => {
    fc.assert(
      fc.property(baseArb, fc.integer({ min: 0, max: 10_000_000 }), (base, delta) => {
        expect(taxOf(base + delta)).toBeGreaterThanOrEqual(taxOf(base));
      }),
    );
  });

  it("国税庁の式（BigInt で厳密に検証）: ≤ T は floor(base×L/10000)、> T は floor(T×L/10000) + floor((base−T)×H/10000)", () => {
    fc.assert(
      fc.property(baseArb, (base) => {
        const b = BigInt(base);
        const expected =
          base <= T
            ? (b * BigInt(L)) / 10000n
            : (BigInt(T) * BigInt(L)) / 10000n + ((b - BigInt(T)) * BigInt(H)) / 10000n;
        expect(BigInt(taxOf(base))).toBe(expected);
      }),
    );
  });

  it("境目付近も式と一致する", () => {
    for (const base of [T - 1, T, T + 1, T + 4, T + 5]) {
      const b = BigInt(base);
      const expected =
        base <= T
          ? (b * BigInt(L)) / 10000n
          : (BigInt(T) * BigInt(L)) / 10000n + ((b - BigInt(T)) * BigInt(H)) / 10000n;
      expect(BigInt(taxOf(base))).toBe(expected);
    }
  });

  it("quickstart の 3 例: 300,000 → 30,630、1,205,000 → 143,961、1,000,000 → 102,100", () => {
    expect(taxOf(300_000)).toBe(30_630);
    expect(taxOf(1_205_000)).toBe(143_961);
    expect(taxOf(1_000_000)).toBe(102_100);
  });

  it("base ≤ 0 は 0", () => {
    expect(taxOf(0)).toBe(0);
    expect(taxOf(-1)).toBe(0);
    expect(taxOf(-1_000_000)).toBe(0);
  });

  it("適用の期間の端: 2013-01-01・2026-12-31・2027-01-01・2047-12-31 は計算でき、2012-12-31 と 2048-01-01 は WITHHOLDING_RATE_MISSING（details.date）", () => {
    expect(taxOf(300_000, "2013-01-01")).toBe(30_630);
    expect(taxOf(300_000, "2026-12-31")).toBe(30_630);
    expect(taxOf(300_000, "2027-01-01")).toBe(30_630);
    expect(taxOf(300_000, "2047-12-31")).toBe(30_630);
    for (const date of ["2012-12-31", "2048-01-01"]) {
      const r = withholdingTax(300_000, date, TAX_PARAMETERS);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("WITHHOLDING_RATE_MISSING");
        expect(r.error.details).toEqual({ date });
      }
    }
  });

  it("値の行が一部欠けても WITHHOLDING_RATE_MISSING", () => {
    const params = TAX_PARAMETERS.filter((p) => p.key !== "WITHHOLDING_RATE_HIGH");
    const r = withholdingTax(300_000, DATE, params);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("WITHHOLDING_RATE_MISSING");
  });
});

describe("withholdingBase (R3)", () => {
  const breakdown = [{ rate: 10, inclusive: 330_000, tax: 30_000, exclusive: 300_000 }];

  it("separate で税率つきの内訳がある → total − Σ tax", () => {
    expect(withholdingBase({ total: 330_000, taxBreakdown: breakdown }, "separate")).toBe(300_000);
    expect(
      withholdingBase(
        {
          total: 500_000,
          taxBreakdown: [
            { rate: 10, inclusive: 330_000, tax: 30_000, exclusive: 300_000 },
            { rate: 8, inclusive: 108_000, tax: 8_000, exclusive: 100_000 },
          ],
        },
        "separate",
      ),
    ).toBe(462_000);
  });

  it("inclusive_only は total のまま", () => {
    expect(withholdingBase({ total: 330_000, taxBreakdown: breakdown }, "inclusive_only")).toBe(
      330_000,
    );
  });

  it("separate でも税率つきの内訳がなければ total", () => {
    expect(withholdingBase({ total: 100_000, taxBreakdown: [] }, "separate")).toBe(100_000);
  });

  it("性質: 0 ≤ base ≤ total（内訳の税額は total を超えない）", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000_000 }),
        fc.integer({ min: 0, max: 100 }),
        fc.constantFrom("separate" as const, "inclusive_only" as const),
        (total, pct, display) => {
          const tax = Math.floor((total * pct) / (100 + pct));
          const base = withholdingBase(
            {
              total,
              taxBreakdown: [{ rate: pct, inclusive: total, tax, exclusive: total - tax }],
            },
            display,
          );
          expect(base).toBeGreaterThanOrEqual(0);
          expect(base).toBeLessThanOrEqual(total);
        },
      ),
    );
  });
});
