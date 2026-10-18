import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { defaultTaxCategory, type JournalContext, validateJournal } from "../src/journal.ts";
import { computeInclusiveTax } from "../src/money.ts";
import { TAX_RATES } from "../src/seed/tax-rates.ts";
import { resolveTaxRate } from "../src/tax-rates.ts";
import type { TaxSettingDraft } from "../src/tax-settings.ts";
import type { AccountCategory, TaxCategoryCode, TaxRate } from "../src/types.ts";
import { amountArb, dateInPeriodArb, makeAccount, makeFiscalPeriod } from "./arbitraries.ts";

const exemptThenGeneral: TaxSettingDraft[] = [
  { effectiveFrom: "2025-01-01", taxpayerStatus: "exempt", accountingMethod: "tax_included" },
  { effectiveFrom: "2026-01-01", taxpayerStatus: "general", accountingMethod: "tax_included" },
];

const CATEGORIES: AccountCategory[] = ["asset", "liability", "equity", "revenue", "expense"];

describe("defaultTaxCategory（FR-017）", () => {
  it.each(CATEGORIES)("免税の期間は %s の科目でも OUT_OF_SCOPE", (category) => {
    for (const side of ["debit", "credit"] as const) {
      expect(defaultTaxCategory("2025-06-01", side, makeAccount(category), exemptThenGeneral)).toBe(
        "OUT_OF_SCOPE",
      );
    }
  });

  it.each<[AccountCategory, TaxCategoryCode]>([
    ["revenue", "SALES_10"],
    ["expense", "PURCHASE_10"],
    ["asset", "OUT_OF_SCOPE"],
    ["liability", "OUT_OF_SCOPE"],
    ["equity", "OUT_OF_SCOPE"],
  ])("課税・税込の期間で %s の科目は %s", (category, expected) => {
    for (const side of ["debit", "credit"] as const) {
      expect(defaultTaxCategory("2026-06-01", side, makeAccount(category), exemptThenGeneral)).toBe(
        expected,
      );
    }
  });

  it("消費税の設定がない日付は OUT_OF_SCOPE", () => {
    expect(
      defaultTaxCategory("2024-12-31", "credit", makeAccount("revenue"), exemptThenGeneral),
    ).toBe("OUT_OF_SCOPE");
  });
});

describe("内税額（INV-10, Constitution VI）", () => {
  const p2029 = makeFiscalPeriod(2029);
  const p2030 = makeFiscalPeriod(2030);
  const sales = makeAccount("revenue");
  const expense = makeAccount("expense");
  const bank = makeAccount("asset");
  /** 2030-01-01 から税率が 12% に変わる架空の改正 */
  const rates: TaxRate[] = [
    ...TAX_RATES,
    {
      categoryCode: "SALES_10",
      rate: 12,
      effectiveFrom: "2030-01-01",
      sourceUrl: "https://example.com",
    },
    {
      categoryCode: "PURCHASE_10",
      rate: 12,
      effectiveFrom: "2030-01-01",
      sourceUrl: "https://example.com",
    },
  ];
  const ctx = (taxSettings: TaxSettingDraft[]): JournalContext => ({
    accounts: [sales, expense, bank],
    subAccounts: [],
    partners: [],
    tags: [],
    periods: [p2029, p2030],
    taxSettings,
    taxRates: rates,
  });
  const general = ctx([
    { effectiveFrom: "2029-01-01", taxpayerStatus: "general", accountingMethod: "tax_included" },
  ]);

  const dateArb = fc.oneof(dateInPeriodArb(p2029), dateInPeriodArb(p2030));

  it("税込経理で課税の区分の行は computeInclusiveTax(amount, resolveTaxRate(...))、それ以外は 0", () => {
    fc.assert(
      fc.property(dateArb, amountArb, (date, amount) => {
        const result = validateJournal(
          {
            date,
            lines: [
              { side: "debit", accountId: bank.id, amount },
              { side: "credit", accountId: sales.id, amount },
            ],
          },
          general,
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const [debitLine, creditLine] = result.value.lines;
        expect(debitLine).toMatchObject({ taxCategory: "OUT_OF_SCOPE", taxAmount: 0 });
        const rate = resolveTaxRate("SALES_10", date, rates);
        expect(rate).toBe(date >= "2030-01-01" ? 12 : 10);
        expect(creditLine).toMatchObject({
          taxCategory: "SALES_10",
          taxAmount: computeInclusiveTax(amount, rate ?? Number.NaN),
        });
      }),
    );
  });

  it("仕訳の日付によって使われる税率が切り替わる", () => {
    const lines = (taxCategory?: TaxCategoryCode) => [
      { side: "debit" as const, accountId: expense.id, amount: 11_000, taxCategory },
      { side: "credit" as const, accountId: bank.id, amount: 11_000 },
    ];
    const before = validateJournal({ date: "2029-12-31", lines: lines() }, general);
    const after = validateJournal({ date: "2030-01-01", lines: lines() }, general);
    expect(before.ok && before.value.lines[0]).toMatchObject({
      taxCategory: "PURCHASE_10",
      taxAmount: 1000,
    });
    expect(after.ok && after.value.lines[0]).toMatchObject({
      taxCategory: "PURCHASE_10",
      taxAmount: computeInclusiveTax(11_000, 12),
    });
    const reduced = validateJournal({ date: "2030-01-01", lines: lines("PURCHASE_8R") }, general);
    expect(reduced.ok && reduced.value.lines[0]).toMatchObject({
      taxCategory: "PURCHASE_8R",
      taxAmount: 814,
    });
  });

  it("免税の期間は、課税の区分を指定しても内税額は 0", () => {
    const exempt = ctx([
      { effectiveFrom: "2029-01-01", taxpayerStatus: "exempt", accountingMethod: "tax_included" },
    ]);
    const result = validateJournal(
      {
        date: "2029-05-01",
        lines: [
          { side: "debit", accountId: bank.id, amount: 11_000 },
          { side: "credit", accountId: sales.id, amount: 11_000, taxCategory: "SALES_10" },
        ],
      },
      exempt,
    );
    expect(result.ok && result.value.lines[1]).toMatchObject({
      taxCategory: "SALES_10",
      taxAmount: 0,
    });
  });

  it("課税の区分で、日付に適用される税率がなければ拒否する", () => {
    const old = makeFiscalPeriod(2019);
    const result = validateJournal(
      {
        date: "2019-09-30",
        lines: [
          { side: "debit", accountId: bank.id, amount: 1080 },
          { side: "credit", accountId: sales.id, amount: 1080, taxCategory: "SALES_10" },
        ],
      },
      {
        ...general,
        periods: [old],
        taxSettings: [
          {
            effectiveFrom: "2019-01-01",
            taxpayerStatus: "general",
            accountingMethod: "tax_included",
          },
        ],
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual([
      expect.objectContaining({
        code: "VALIDATION",
        details: expect.objectContaining({ lineIndex: 1, field: "taxCategory" }),
      }),
    ]);
  });
});
