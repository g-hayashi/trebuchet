import { BlueReturn } from "@trebuchet/schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildBlueReturn } from "../../src/blue-return/build.ts";
import { buildProfitAndLoss } from "../../src/reports/profit-and-loss.ts";
import { TAX_PARAMETERS } from "../../src/seed/tax-parameters.ts";
import type { DeductionAnswers } from "../../src/types.ts";
import { yearLedgerArb } from "../blue-return-arbitraries.ts";

const answersArb: fc.Arbitrary<DeductionAnswers | null> = fc.option(
  fc.record({
    fiscalYear: fc.constant(2025),
    doubleEntry: fc.boolean(),
    statementsAttached: fc.boolean(),
    filedOnTime: fc.boolean(),
    eTax: fc.boolean(),
    electronicBooks: fc.boolean(),
    updatedAt: fc.constant("2026-01-10T00:00:00.000Z"),
  }),
  { nil: null },
);

describe("buildBlueReturn の性質（INV-18・INV-22）", () => {
  it("INV-18: 欄32・欄33 は 001 の PL の費用合計と利益に等しく、欄43 = 欄33、欄45 = 欄43 − 欄44", () => {
    fc.assert(
      fc.property(yearLedgerArb, answersArb, (ledger, deductionAnswers) => {
        const r = buildBlueReturn({
          period: ledger.period,
          accounts: ledger.accounts,
          lines: ledger.lines,
          deductionAnswers,
          taxParameters: TAX_PARAMETERS,
        });
        const pl = buildProfitAndLoss({
          accounts: ledger.accounts,
          lines: ledger.lines,
          from: ledger.period.startDate,
          to: ledger.period.endDate,
        });
        const section = (s: string) => pl.sections.find((x) => x.section === s)?.total.amount ?? 0;
        const amountOf = (no: number) => r.page1.lines.find((l) => l.no === no)?.amount;

        expect(amountOf(32)).toBe(section("PL_COGS") + section("PL_EXPENSE"));
        expect(amountOf(33)).toBe(pl.netIncome.amount);
        expect(amountOf(43)).toBe(amountOf(33));
        expect(r.warnings.map((w) => w.code)).not.toContain("PL_MISMATCH");
        expect(r.warnings.map((w) => w.code)).not.toContain("OPTIONAL_LINES_OVERFLOW");

        const line43 = amountOf(43) as number;
        if (deductionAnswers === null) {
          expect(amountOf(44)).toBeNull();
          expect(amountOf(45)).toBeNull();
          expect(r.transfer).toEqual({ businessIncome: null, blueDeduction: null });
          expect(r.page2.deduction).toBeNull();
          expect(r.warnings.map((w) => w.code)).toContain("DEDUCTION_ANSWERS_MISSING");
        } else {
          const d = r.page2.deduction;
          expect(d).not.toBeNull();
          // INV-22
          expect(amountOf(44)).toBe(Math.min(d?.cap ?? 0, Math.max(0, line43)));
          expect(d?.amount).toBe(amountOf(44));
          expect(amountOf(44) as number).toBeGreaterThanOrEqual(0);
          expect(amountOf(44) as number).toBeLessThanOrEqual(d?.cap ?? 0);
          expect(amountOf(45)).toBe(line43 - (amountOf(44) as number));
          expect(r.transfer).toEqual({
            businessIncome: amountOf(45),
            blueDeduction: amountOf(44),
          });
          expect(r.warnings.map((w) => w.code)).not.toContain("DEDUCTION_ANSWERS_MISSING");
        }
      }),
    );
  });

  it("使わない欄を含め、すべての欄は整数（欄44・45 だけ回答なしで null）で、BlueReturn の schema に合う", () => {
    fc.assert(
      fc.property(yearLedgerArb, answersArb, (ledger, deductionAnswers) => {
        const r = buildBlueReturn({
          period: ledger.period,
          accounts: ledger.accounts,
          lines: ledger.lines,
          deductionAnswers,
          taxParameters: TAX_PARAMETERS,
        });
        expect(BlueReturn.safeParse(r).success).toBe(true);
        for (const l of r.page1.lines) {
          if (l.amount === null) {
            expect([44, 45]).toContain(l.no);
            expect(deductionAnswers).toBeNull();
          } else {
            expect(Number.isInteger(l.amount)).toBe(true);
          }
        }
      }),
    );
  });

  it("売上のない・仕訳のない年度でも欄はすべて 0", () => {
    fc.assert(
      fc.property(yearLedgerArb, (ledger) => {
        const r = buildBlueReturn({
          period: ledger.period,
          accounts: ledger.accounts,
          lines: [],
          deductionAnswers: null,
          taxParameters: TAX_PARAMETERS,
        });
        for (const l of r.page1.lines) {
          if (l.no === 44 || l.no === 45) expect(l.amount).toBeNull();
          else expect(l.amount).toBe(0);
        }
      }),
      { numRuns: 5 },
    );
  });
});
