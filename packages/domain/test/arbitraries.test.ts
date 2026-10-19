import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { sumYen } from "../src/money.ts";
import {
  accountSetArb,
  balancedLinesArb,
  balancedOpeningArb,
  dateInPeriodArb,
  makeFiscalPeriod,
} from "./arbitraries.ts";

describe("arbitraries", () => {
  it("accountSetArb は各区分を1つ以上含む", () => {
    fc.assert(
      fc.property(accountSetArb, (accounts) => {
        const categories = new Set(accounts.map((a) => a.category));
        expect(categories.size).toBe(5);
      }),
    );
  });

  it("balancedLinesArb は 2〜8 行で貸借が一致する", () => {
    fc.assert(
      fc.property(accountSetArb.chain(balancedLinesArb), (lines) => {
        expect(lines.length).toBeGreaterThanOrEqual(2);
        expect(lines.length).toBeLessThanOrEqual(8);
        const debit = lines.filter((l) => l.side === "debit");
        const credit = lines.filter((l) => l.side === "credit");
        expect(debit.length).toBeGreaterThan(0);
        expect(credit.length).toBeGreaterThan(0);
        expect(sumYen(debit.map((l) => l.amount))).toBe(sumYen(credit.map((l) => l.amount)));
        for (const l of lines) expect(l.amount).toBeGreaterThan(0);
      }),
    );
  });

  it("balancedOpeningArb は貸借が一致し、科目が重複しない", () => {
    fc.assert(
      fc.property(accountSetArb.chain(balancedOpeningArb), (rows) => {
        const debit = sumYen(rows.filter((r) => r.side === "debit").map((r) => r.amount));
        const credit = sumYen(rows.filter((r) => r.side === "credit").map((r) => r.amount));
        expect(debit).toBe(credit);
        expect(new Set(rows.map((r) => r.accountId)).size).toBe(rows.length);
      }),
    );
  });

  it("dateInPeriodArb は会計期間内の日付", () => {
    const period = makeFiscalPeriod(2024);
    fc.assert(
      fc.property(dateInPeriodArb(period), (date) => {
        expect(date >= period.startDate && date <= period.endDate).toBe(true);
      }),
    );
  });
});
