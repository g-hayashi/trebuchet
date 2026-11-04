import { CASH_AND_DEPOSIT_CODES } from "@trebuchet/schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createJournal } from "../../src/usecases/create-journal.ts";
import { getHomeSummary } from "../../src/usecases/home.ts";
import { getBalanceSheet, getProfitAndLoss } from "../../src/usecases/reports.ts";
import { balancedLinesArb, dateInPeriodArb } from "../arbitraries.ts";
import { setupHome } from "../home-setup.ts";
import { TODAY } from "../test-dates.ts";

// INV-72: HomeSummary.figures の売上・経費・利益は同じ会計期間の損益計算書の値と、現金と預金は今日時点の
// 貸借対照表の該当の行の合計と一致する（data-model §4）

const template = setupHome();
const accounts = template.masters.listAccounts().filter((a) => a.isActive);
const period2025 = template.masters.getFiscalPeriodByYear(2025);
const period2026 = template.masters.getFiscalPeriodByYear(2026);
if (period2025 === undefined || period2026 === undefined) throw new Error("period");

const journalArb = fc.record({
  date: fc.oneof(dateInPeriodArb(period2025), dateInPeriodArb(period2026)),
  lines: balancedLinesArb(accounts),
});

describe("INV-72 ホームの今期の数字は帳票と一致する", () => {
  it("任意の貸借一致の仕訳の集合で、売上・経費・利益・現金と預金が損益計算書・貸借対照表と一致し、行の足し上げとも一致する", () => {
    fc.assert(
      fc.property(fc.array(journalArb, { maxLength: 15 }), (journals) => {
        const t = setupHome();
        for (const j of journals) createJournal(t.ledgerDeps, j);

        const figures = getHomeSummary(t.deps, TODAY).figures;
        expect(figures.status).toBe("ok");
        if (figures.status !== "ok" || figures.value === null) throw new Error("figures");
        const f = figures.value;
        expect([f.from, f.to]).toEqual([period2026.startDate, period2026.endDate]);

        const pl = getProfitAndLoss(t.deps.blueReturn, { from: f.from, to: f.to });
        const bs = getBalanceSheet(t.deps.blueReturn, { asOf: TODAY });
        if (!pl.ok || !bs.ok) throw new Error("report");
        const total = (section: string) =>
          pl.value.sections.find((s) => s.section === section)?.total.amount ?? 0;
        expect(f.sales).toBe(total("PL_SALES"));
        expect(f.expenses).toBe(total("PL_COGS") + total("PL_EXPENSE"));
        expect(f.netIncome).toBe(pl.value.netIncome.amount);
        const bsCash = bs.value.sections
          .flatMap((s) => s.rows)
          .filter((r) => CASH_AND_DEPOSIT_CODES.includes(r.code))
          .reduce((sum, r) => sum + r.amount, 0);
        expect(f.cashAndDeposits).toBe(bsCash);

        // 帳簿の行からの独立した計算（帳票と同じ関数を通した結果が、行の素朴な足し上げと合うこと）
        const byId = new Map(t.masters.listAccounts().map((a) => [a.id, a]));
        let sales = 0;
        let expenses = 0;
        let cash = 0;
        for (const j of t.ledger.state.journals) {
          if (j.status !== "active") continue;
          for (const l of j.lines) {
            const a = byId.get(l.accountId);
            if (a === undefined) continue;
            const signed = l.side === "debit" ? l.amount : -l.amount;
            if (j.date >= period2026.startDate && j.date <= period2026.endDate) {
              if (a.reportSection === "PL_SALES") sales -= signed;
              if (a.reportSection === "PL_COGS" || a.reportSection === "PL_EXPENSE")
                expenses += signed;
            }
            if (
              j.date >= period2026.startDate &&
              j.date <= TODAY &&
              CASH_AND_DEPOSIT_CODES.includes(a.code)
            ) {
              cash += signed;
            }
          }
        }
        expect(f.sales).toBe(sales);
        expect(f.expenses).toBe(expenses);
        expect(f.cashAndDeposits).toBe(cash);
      }),
      { numRuns: 60 },
    );
  });

  it("今日を含む会計期間がなければ figures は null", () => {
    const t = setupHome();
    const s = getHomeSummary(t.deps, "2031-06-01");
    expect(s.figures).toEqual({ status: "ok", value: null });
  });
});
