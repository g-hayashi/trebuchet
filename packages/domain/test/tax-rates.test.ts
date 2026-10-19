import type { TaxCategoryCode } from "@trebuchet/schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { TAX_CATEGORIES } from "../src/seed/tax-categories.ts";
import { TAX_RATES } from "../src/seed/tax-rates.ts";
import { resolveTaxRate } from "../src/tax-rates.ts";
import type { TaxRate } from "../src/types.ts";
import { dateInPeriodArb, makeFiscalPeriod } from "./arbitraries.ts";

const ALL_CODES: TaxCategoryCode[] = [
  "OUT_OF_SCOPE",
  "SALES_10",
  "SALES_8R",
  "PURCHASE_10",
  "PURCHASE_8R",
  "EXEMPT",
  "NON_TAXABLE",
];
const TAXABLE: TaxCategoryCode[] = ["SALES_10", "SALES_8R", "PURCHASE_10", "PURCHASE_8R"];

const dateArb = dateInPeriodArb(makeFiscalPeriod(2015, { endDate: "2035-12-31" }));

describe("税区分の参照データ（FR-010）", () => {
  it("7つの税区分を持ち、課税の区分だけが sales / purchase の kind を持つ", () => {
    expect(TAX_CATEGORIES.map((c) => c.code).sort()).toEqual([...ALL_CODES].sort());
    const kinds = Object.fromEntries(TAX_CATEGORIES.map((c) => [c.code, c.kind]));
    expect(kinds).toEqual({
      OUT_OF_SCOPE: null,
      SALES_10: "sales",
      SALES_8R: "sales",
      PURCHASE_10: "purchase",
      PURCHASE_8R: "purchase",
      EXEMPT: null,
      NON_TAXABLE: null,
    });
    for (const c of TAX_CATEGORIES) expect(c.name.length).toBeGreaterThan(0);
  });
});

describe("税率の参照データ（Constitution VI）", () => {
  it("課税の4区分に 2019-10-01 からの税率（10%・8%）がある", () => {
    const rates = Object.fromEntries(
      TAX_RATES.filter((r) => r.effectiveFrom === "2019-10-01").map((r) => [
        r.categoryCode,
        r.rate,
      ]),
    );
    expect(rates).toEqual({ SALES_10: 10, PURCHASE_10: 10, SALES_8R: 8, PURCHASE_8R: 8 });
  });

  it("各行の sourceUrl が空でない https の URL", () => {
    for (const r of TAX_RATES) {
      expect(r.sourceUrl.length, r.categoryCode).toBeGreaterThan(0);
      expect(new URL(r.sourceUrl).protocol).toBe("https:");
    }
  });

  it("(区分, 適用開始日) が重複しない", () => {
    const keys = TAX_RATES.map((r) => `${r.categoryCode}@${r.effectiveFrom}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("課税の区分以外の行がない", () => {
    for (const r of TAX_RATES) expect(TAXABLE).toContain(r.categoryCode);
  });
});

describe("resolveTaxRate（INV-10）", () => {
  it("初期データで、2019-10-01 以降の日付は 10% / 8%、それより前は undefined", () => {
    expect(resolveTaxRate("SALES_10", "2026-10-31", TAX_RATES)).toBe(10);
    expect(resolveTaxRate("PURCHASE_8R", "2019-10-01", TAX_RATES)).toBe(8);
    expect(resolveTaxRate("SALES_10", "2019-09-30", TAX_RATES)).toBeUndefined();
  });

  it("課税の区分以外は undefined", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<TaxCategoryCode>("OUT_OF_SCOPE", "EXEMPT", "NON_TAXABLE"),
        dateArb,
        (code, date) => {
          expect(resolveTaxRate(code, date, TAX_RATES)).toBeUndefined();
        },
      ),
    );
  });

  it("適用開始日の異なる行があれば、日付によって税率が切り替わる", () => {
    const rates: TaxRate[] = [
      ...TAX_RATES,
      {
        categoryCode: "SALES_8R",
        rate: 0,
        effectiveFrom: "2027-04-01",
        sourceUrl: "https://example.com/a",
      },
      {
        categoryCode: "SALES_8R",
        rate: 8,
        effectiveFrom: "2029-04-01",
        sourceUrl: "https://example.com/b",
      },
    ];
    expect(resolveTaxRate("SALES_8R", "2027-03-31", rates)).toBe(8);
    expect(resolveTaxRate("SALES_8R", "2027-04-01", rates)).toBe(0);
    expect(resolveTaxRate("SALES_8R", "2029-03-31", rates)).toBe(0);
    expect(resolveTaxRate("SALES_8R", "2029-04-01", rates)).toBe(8);
    expect(resolveTaxRate("SALES_10", "2028-01-01", rates)).toBe(10);
  });

  it("任意の税率データと日付で、effectiveFrom <= date のうち最新の税率を返す（オラクルと一致）", () => {
    const ratesArb = fc.uniqueArray(
      fc.record({
        categoryCode: fc.constantFrom(...TAXABLE),
        rate: fc.integer({ min: 0, max: 30 }),
        effectiveFrom: dateArb,
        sourceUrl: fc.constant("https://example.com/"),
      }),
      { selector: (r) => `${r.categoryCode}@${r.effectiveFrom}`, maxLength: 12 },
    );
    fc.assert(
      fc.property(ratesArb, fc.constantFrom(...ALL_CODES), dateArb, (rates, code, date) => {
        const latest = rates
          .filter((r) => r.categoryCode === code && r.effectiveFrom <= date)
          .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
        expect(resolveTaxRate(code, date, rates)).toBe(latest?.rate);
      }),
    );
  });
});
