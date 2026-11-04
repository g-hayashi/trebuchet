import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildBlueReturn } from "../../src/blue-return/build.ts";
import { formForYear } from "../../src/blue-return/form.ts";
import { summarizeMonthlySales, summarizeSalesPartners } from "../../src/blue-return/sales.ts";
import { STRAIGHT_LINE_RATES } from "../../src/seed/depreciation-rates.ts";
import { TAX_PARAMETERS } from "../../src/seed/tax-parameters.ts";
import type { FiscalPeriod, PostedLine } from "../../src/types.ts";
import { amountArb, dateInPeriodArb, makeFiscalPeriod } from "../arbitraries.ts";
import {
  accountIdOf,
  INDIVIDUAL_ACCOUNT_LIST,
  LEDGER_YEAR,
  yearLedgerArb,
} from "../blue-return-arbitraries.ts";

const ROWS = formForYear(LEDGER_YEAR).salesPartnerRows;

/** 取引先は様式の行数より多い 8 件。名前は重複もあり得る（同名の別の取引先） */
const PARTNERS = Array.from({ length: 8 }, (_, i) => ({
  id: `partner-${i + 1}`,
  name: `取引先${(i % 6) + 1}`,
}));

/** 売上高・雑収入の行（貸方・借方、取引先あり・なし）と、売上以外の行。期間外の日付と取消済みも含む */
const salesLineArb = (fiscalPeriod: FiscalPeriod): fc.Arbitrary<PostedLine> =>
  fc
    .record({
      date: fc.oneof(
        { weight: 8, arbitrary: dateInPeriodArb(fiscalPeriod) },
        { weight: 1, arbitrary: fc.constantFrom("2024-12-31", "2026-01-01") },
      ),
      code: fc.constantFrom("4010", "4010", "4010", "4020", "1010", "5170"),
      side: fc.constantFrom("credit", "credit", "credit", "debit"),
      amount: amountArb,
      partner: fc.option(fc.constantFrom(...PARTNERS), { nil: null, freq: 4 }),
      status: fc.constantFrom("active", "active", "active", "active", "voided"),
    })
    .map(
      ({ date, code, side, amount, partner, status }): PostedLine => ({
        journalId: "j",
        journalNo: 1,
        date,
        memo: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        status: status as PostedLine["status"],
        lineNo: 1,
        side: side as PostedLine["side"],
        accountId: accountIdOf(code),
        accountName: "",
        subAccountId: null,
        subAccountName: null,
        amount,
        taxCategory: "OUT_OF_SCOPE",
        taxAmount: 0,
        partnerId: partner?.id ?? null,
        partnerName: partner?.name ?? null,
        description: null,
      }),
    );

const period = makeFiscalPeriod(LEDGER_YEAR);
const linesArb = fc.array(salesLineArb(period), { maxLength: 40 });

const line1Of = (lines: PostedLine[]) =>
  buildBlueReturn({
    period,
    accounts: INDIVIDUAL_ACCOUNT_LIST,
    lines,
    deductionAnswers: null,
    taxParameters: TAX_PARAMETERS,
    straightLineRates: STRAIGHT_LINE_RATES,
  });

describe("売上の集計の性質（INV-24）", () => {
  it("INV-24: 月別売上の合計 = 欄1 = 売上先の明細の合計（個別の行 + 上記以外の計）で、警告 SALES_TOTAL_MISMATCH は出ない", () => {
    fc.assert(
      fc.property(linesArb, (lines) => {
        const r = line1Of(lines);
        const line1 = r.page1.lines.find((l) => l.no === 1)?.amount ?? Number.NaN;
        const sp = r.page3.salesPartners;
        const partnersTotal = sp.rows.reduce((s, x) => s + x.amount, 0) + sp.others;
        expect(r.page2.monthly.total.total).toBe(line1);
        expect(partnersTotal).toBe(line1);
        expect(sp.total).toBe(line1);
        expect(r.warnings.map((w) => w.code)).not.toContain("SALES_TOTAL_MISMATCH");
        // 月ごとの合計も年間の合計に一致する
        const months = r.page2.monthly.months;
        expect(months).toHaveLength(12);
        expect(months.reduce((s, m) => s + m.sales, 0)).toBe(r.page2.monthly.total.sales);
        expect(months.reduce((s, m) => s + m.otherIncome, 0)).toBe(
          r.page2.monthly.total.otherIncome,
        );
        for (const m of months) expect(m.total).toBe(m.sales + m.otherIncome);
      }),
    );
  });

  it("INV-24: 帳簿の生成器（yearLedgerArb）の帳簿でも、3つの合計が欄1に一致する", () => {
    fc.assert(
      fc.property(yearLedgerArb, (ledger) => {
        const r = buildBlueReturn({
          period: ledger.period,
          accounts: ledger.accounts,
          lines: ledger.lines,
          deductionAnswers: null,
          taxParameters: TAX_PARAMETERS,
          straightLineRates: STRAIGHT_LINE_RATES,
        });
        const line1 = r.page1.lines.find((l) => l.no === 1)?.amount;
        const sp = r.page3.salesPartners;
        expect(r.page2.monthly.total.total).toBe(line1);
        expect(sp.rows.reduce((s, x) => s + x.amount, 0) + sp.others).toBe(line1);
        expect(sp.total).toBe(line1);
        expect(r.warnings.map((w) => w.code)).not.toContain("SALES_TOTAL_MISMATCH");
      }),
    );
  });

  it("売上先の個別の行は様式の行数以下で、金額の降順（同額は名前順）、0 以下は含めない", () => {
    fc.assert(
      fc.property(linesArb, (lines) => {
        const { rows } = summarizeSalesPartners(lines, INDIVIDUAL_ACCOUNT_LIST, period, ROWS);
        expect(rows.length).toBeLessThanOrEqual(ROWS);
        for (const r of rows) expect(r.amount).toBeGreaterThan(0);
        for (let i = 1; i < rows.length; i++) {
          const a = rows[i - 1];
          const b = rows[i];
          if (a === undefined || b === undefined) throw new Error("unreachable");
          expect(a.amount > b.amount || (a.amount === b.amount && a.name <= b.name)).toBe(true);
        }
        // 同じ取引先は1行だけ
        expect(new Set(rows.map((r) => r.partnerId)).size).toBe(rows.length);
      }),
    );
  });

  it("個別に出さなかった取引先の金額は、個別の行の最小額を超えない（大きい順に取っている）", () => {
    fc.assert(
      fc.property(linesArb, (lines) => {
        const all = summarizeSalesPartners(lines, INDIVIDUAL_ACCOUNT_LIST, period, 100).rows;
        const top = summarizeSalesPartners(lines, INDIVIDUAL_ACCOUNT_LIST, period, ROWS).rows;
        expect(top).toEqual(all.slice(0, ROWS));
      }),
    );
  });

  it("取引先なしの件数と金額は、取引先のない売上高の行の件数と貸方−借方に一致する", () => {
    fc.assert(
      fc.property(linesArb, (lines) => {
        const s = summarizeSalesPartners(lines, INDIVIDUAL_ACCOUNT_LIST, period, ROWS);
        const target = lines.filter(
          (l) =>
            l.accountId === accountIdOf("4010") &&
            l.status === "active" &&
            l.date >= period.startDate &&
            l.date <= period.endDate &&
            l.partnerId === null,
        );
        const amount = target.reduce(
          (sum, l) => sum + (l.side === "credit" ? l.amount : -l.amount),
          0,
        );
        if (target.length === 0) expect(s.withoutPartner).toBeNull();
        else expect(s.withoutPartner).toEqual({ count: target.length, amount });
      }),
    );
  });

  it("月別の売上は 4010 の貸方−借方を月ごとに足したもの", () => {
    fc.assert(
      fc.property(linesArb, (lines) => {
        const m = summarizeMonthlySales(lines, INDIVIDUAL_ACCOUNT_LIST, period);
        for (const month of m.months) {
          const expected = lines
            .filter(
              (l) =>
                l.accountId === accountIdOf("4010") &&
                l.status === "active" &&
                l.date >= period.startDate &&
                l.date <= period.endDate &&
                Number(l.date.slice(5, 7)) === month.month,
            )
            .reduce((sum, l) => sum + (l.side === "credit" ? l.amount : -l.amount), 0);
          expect(month.sales).toBe(expected);
        }
      }),
    );
  });
});
