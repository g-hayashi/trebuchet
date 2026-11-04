import { BlueReturn } from "@trebuchet/schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildBlueReturn } from "../../src/blue-return/build.ts";
import { carryForward } from "../../src/carry-forward.ts";
import { buildBalanceSheet } from "../../src/reports/balance-sheet.ts";
import { computeBalances } from "../../src/reports/balances.ts";
import type { OpeningInput } from "../../src/reports/common.ts";
import { buildProfitAndLoss } from "../../src/reports/profit-and-loss.ts";
import { STRAIGHT_LINE_RATES } from "../../src/seed/depreciation-rates.ts";
import { TAX_PARAMETERS } from "../../src/seed/tax-parameters.ts";
import type {
  Account,
  AccountCategory,
  DeductionAnswers,
  FiscalPeriod,
  LineDraft,
  PostedLine,
} from "../../src/types.ts";
import {
  balancedLinesArb,
  balancedOpeningArb,
  dateInPeriodArb,
  makeAccount,
  makeFiscalPeriod,
  type OpeningRow,
} from "../arbitraries.ts";
import {
  accountIdOf,
  straightLineAssetArb,
  type YearLedger,
  yearLedgerArb,
} from "../blue-return-arbitraries.ts";

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
          straightLineRates: STRAIGHT_LINE_RATES,
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
          straightLineRates: STRAIGHT_LINE_RATES,
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

  it("INV-18・19（009）: 定額法の資産・除却損の科目を含めても、欄32・33 は PL と一致し、3 ページの行は整合し、4 ページは貸借が一致する", () => {
    fc.assert(
      fc.property(
        yearLedgerArb,
        fc.array(straightLineAssetArb, { maxLength: 5 }),
        (ledger, fixedAssets) => {
          const r = buildBlueReturn({
            period: ledger.period,
            accounts: ledger.accounts,
            lines: ledger.lines,
            deductionAnswers: null,
            taxParameters: TAX_PARAMETERS,
            straightLineRates: STRAIGHT_LINE_RATES,
            fixedAssets,
            opening: ledger.opening,
          });
          const pl = buildProfitAndLoss({
            accounts: ledger.accounts,
            lines: ledger.lines,
            from: ledger.period.startDate,
            to: ledger.period.endDate,
          });
          const section = (s: string) =>
            pl.sections.find((x) => x.section === s)?.total.amount ?? 0;
          const amountOf = (no: number) => r.page1.lines.find((l) => l.no === no)?.amount;
          expect(amountOf(32)).toBe(section("PL_COGS") + section("PL_EXPENSE"));
          expect(amountOf(33)).toBe(pl.netIncome.amount);
          expect(r.warnings.map((w) => w.code)).not.toContain("PL_MISMATCH");
          expect(BlueReturn.safeParse(r).success).toBe(true);
          // 3 ページの行は、率の表にある定額法の資産だけで、必要経費算入額は償却費合計と割合から決まる
          const ids = new Set(fixedAssets.map((a) => a.id));
          for (const row of r.page3.depreciation) {
            expect(ids.has(row.assetId)).toBe(true);
            expect(row.source).toBe("fixed_asset");
            expect(row.method).toBe("straight_line");
            expect(row.ratePermille).not.toBeNull();
            expect(row.months).not.toBeNull();
            expect(row.deductible).toBe(Math.floor((row.total * row.businessRatio) / 10000));
          }
          // 4 ページ（INV-19）: 期首・期末とも資産合計 = 負債・資本合計
          for (const when of ["opening", "closing"] as const) {
            expect(r.page4[when].assets.total).toBe(r.page4[when].liabilityEquity.total);
          }
          // 率の表が全部ある（耐用年数 2〜50）ので、計算できない警告は出ない
          expect(r.warnings.map((w) => w.code)).not.toContain("DEPRECIATION_PARAMETER_MISSING");
        },
      ),
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
          straightLineRates: STRAIGHT_LINE_RATES,
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

// ---- INV-19（4ページの貸借の一致） ----

const INCOME = "青色申告特別控除前の所得金額";

type Page4Input = {
  period: FiscalPeriod;
  accounts: readonly Account[];
  opening: readonly OpeningInput[];
  lines: readonly PostedLine[];
};

const build4 = (
  input: Page4Input,
  priorPeriod: Parameters<typeof buildBlueReturn>[0]["priorPeriod"] = null,
) =>
  buildBlueReturn({
    ...input,
    deductionAnswers: null,
    taxParameters: TAX_PARAMETERS,
    straightLineRates: STRAIGHT_LINE_RATES,
    priorPeriod,
  });

const sumShown = (rows: readonly { amount: number | null }[]) =>
  rows.reduce((s, x) => s + (x.amount ?? 0), 0);

const shownAt = (rows: readonly { label: string; amount: number | null }[], label: string) =>
  rows.find((x) => x.label === label)?.amount;

/**
 * INV-19: 期首・期末とも、表示した金額の資産合計 = 負債・資本合計（期末は控除前の所得を含む）。
 * 合計は表示した金額の和で、001 の貸借対照表（期首は期首残高だけ、期末は年度末日）の合計と等しい（金額を落とさない）
 */
function expectInv19(input: Page4Input, r: ReturnType<typeof buildBlueReturn>) {
  expect(BlueReturn.safeParse(r).success).toBe(true);
  for (const when of ["opening", "closing"] as const) {
    const { assets, liabilityEquity } = r.page4[when];
    expect(assets.total).toBe(sumShown(assets.rows));
    expect(liabilityEquity.total).toBe(sumShown(liabilityEquity.rows));
    expect(assets.total).toBe(liabilityEquity.total);
    for (const row of [...assets.rows, ...liabilityEquity.rows]) {
      if (row.amount !== null) expect(Number.isInteger(row.amount)).toBe(true);
    }
  }
  const { period, accounts, opening, lines } = input;
  const closing = buildBalanceSheet({
    accounts,
    opening,
    lines,
    periodStart: period.startDate,
    asOf: period.endDate,
  });
  expect(r.page4.closing.assets.total).toBe(closing.totalAssets.amount);
  expect(r.page4.closing.liabilityEquity.total).toBe(closing.totalLiabilitiesAndEquity.amount);
  expect(shownAt(r.page4.closing.liabilityEquity.rows, INCOME)).toBe(closing.netIncome.amount);
  const atOpening = buildBalanceSheet({
    accounts,
    opening,
    lines: [],
    periodStart: period.startDate,
    asOf: period.startDate,
  });
  expect(r.page4.opening.assets.total).toBe(atOpening.totalAssets.amount);
  expect(r.page4.opening.liabilityEquity.total).toBe(atOpening.totalLiabilitiesAndEquity.amount);
}

const ACCOUNT_NAME = (accounts: readonly Account[], id: string) =>
  accounts.find((a) => a.id === id)?.name ?? "";

function postedLines(
  accounts: readonly Account[],
  journals: readonly { date: string; lines: LineDraft[] }[],
  offset: number,
): PostedLine[] {
  return journals.flatMap((j, index) =>
    j.lines.map(
      (l, i): PostedLine => ({
        journalId: `extra-${offset + index + 1}`,
        journalNo: offset + index + 1,
        date: j.date,
        memo: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        status: "active",
        lineNo: i + 1,
        side: l.side,
        accountId: l.accountId,
        accountName: ACCOUNT_NAME(accounts, l.accountId),
        subAccountId: null,
        subAccountName: null,
        amount: l.amount,
        taxCategory: "OUT_OF_SCOPE",
        taxAmount: 0,
        partnerId: null,
        partnerName: null,
        description: null,
      }),
    ),
  );
}

const SECTION_BASE: Record<"asset" | "liability" | "equity", number> = {
  asset: 1_500,
  liability: 2_500,
  equity: 3_500,
};

/**
 * yearLedgerArb に、様式に行のない科目（仮払金・一括償却資産・開業費・未払費用）、利用者が足した科目
 * （空欄の行からあふれることがある）、期首の事業主貸・事業主借・損益の残高、それらを使う仕訳を足した帳簿
 */
const widenedLedgerArb = (usesBusinessAccount: boolean): fc.Arbitrary<Page4Input & YearLedger> =>
  yearLedgerArb
    .filter((l) => l.usesBusinessAccount === usesBusinessAccount)
    .chain((ledger) =>
      fc
        .array(fc.constantFrom<AccountCategory>("asset", "asset", "liability", "equity"), {
          maxLength: 4,
        })
        .map((categories) =>
          categories.map((category, i) =>
            makeAccount(category, {
              code: `9${i}`,
              name: `追加${i}`,
              sortOrder: SECTION_BASE[category as "asset"] + i,
            }),
          ),
        )
        .chain((added) => {
          const accounts = [...ledger.accounts, ...added];
          const pool = [
            ...["1010", "1030", "1050", "1070", "1080", "2030", "3010", "3020", "3090"],
            ...["4010", "5120"],
          ]
            .map((code) => accounts.find((a) => a.id === accountIdOf(code)))
            .filter((a): a is Account => a !== undefined)
            .concat(added);
          return fc.record({
            accounts: fc.constant(accounts),
            extraOpening: fc.option(balancedOpeningArb(pool), { nil: [] as OpeningRow[] }),
            extraJournals: fc.array(
              fc.record({ date: dateInPeriodArb(ledger.period), lines: balancedLinesArb(pool) }),
              { maxLength: 8 },
            ),
          });
        })
        .map(({ accounts, extraOpening, extraJournals }) => ({
          ...ledger,
          accounts,
          opening: [
            ...ledger.opening,
            ...extraOpening.map((o, i) => ({
              id: `extra-opening-${i}`,
              fiscalPeriodId: ledger.period.id,
              subAccountId: null,
              ...o,
            })),
          ],
          lines: [...ledger.lines, ...postedLines(accounts, extraJournals, ledger.lines.length)],
        })),
    );

describe("buildBlueReturn の4ページの性質（INV-19, FR-028・FR-032）", () => {
  for (const usesBusinessAccount of [true, false]) {
    const shape = usesBusinessAccount ? "事業用の口座あり" : "事業用の口座なし（事業主貸・借）";

    it(`${shape}: 期首・期末とも表示した金額で資産合計 = 負債・資本合計、期末の所得は欄43、期首の所得・事業主貸・事業主借は空欄`, () => {
      fc.assert(
        fc.property(
          yearLedgerArb.filter((l) => l.usesBusinessAccount === usesBusinessAccount),
          (ledger) => {
            const r = build4(ledger);
            expectInv19(ledger, r);
            const line43 = r.page1.lines.find((l) => l.no === 43)?.amount;
            expect(shownAt(r.page4.closing.liabilityEquity.rows, INCOME)).toBe(line43);
            expect(shownAt(r.page4.opening.liabilityEquity.rows, INCOME)).toBeNull();
            expect(shownAt(r.page4.opening.assets.rows, "事業主貸")).toBeNull();
            expect(shownAt(r.page4.opening.liabilityEquity.rows, "事業主借")).toBeNull();
            const codes = r.warnings.map((w) => w.code);
            expect(codes).not.toContain("OPENING_OWNER_ACCOUNTS");
            expect(codes).not.toContain("OPTIONAL_LINES_OVERFLOW");
            expect(r.page4.carryForwardCheck).toBe("no_prior_year");
          },
        ),
      );
    });

    it(`${shape}: 空欄の行の科目・あふれ・期首の事業主貸・借・損益があっても、表示した金額で一致する`, () => {
      fc.assert(
        fc.property(widenedLedgerArb(usesBusinessAccount), (ledger) => {
          expectInv19(ledger, build4(ledger));
        }),
      );
    });

    it(`${shape}: 前の年度の期末から carryForward した期首なら、繰越の検査は一致し、期首の事業主貸・借・所得は空欄`, () => {
      fc.assert(
        fc.property(widenedLedgerArb(usesBusinessAccount), (prior) => {
          const balances = computeBalances({
            opening: prior.opening,
            lines: prior.lines,
            periodStart: prior.period.startDate,
            to: prior.period.endDate,
          });
          const carried = carryForward(balances, prior.accounts);
          if (!carried.ok) throw new Error(JSON.stringify(carried.error));
          const next: Page4Input = {
            period: makeFiscalPeriod(prior.period.fiscalYear + 1),
            accounts: prior.accounts,
            opening: carried.value,
            lines: [],
          };
          const r = build4(next, {
            fiscalYear: prior.period.fiscalYear,
            status: "closed",
            closing: balances,
          });
          expectInv19(next, r);
          expect(r.page4.carryForwardCheck).toBe("matched");
          const codes = r.warnings.map((w) => w.code);
          expect(codes).not.toContain("OPENING_MISMATCH");
          expect(codes).not.toContain("OPENING_OWNER_ACCOUNTS");
          expect(shownAt(r.page4.opening.liabilityEquity.rows, INCOME)).toBeNull();
          expect(shownAt(r.page4.opening.assets.rows, "事業主貸")).toBeNull();
          expect(shownAt(r.page4.opening.liabilityEquity.rows, "事業主借")).toBeNull();
          // 前の年度の期末の資産合計がそのまま期首の資産合計になる（事業主貸を除く）
          const priorBs = build4(prior).page4.closing;
          const drawings = shownAt(priorBs.assets.rows, "事業主貸") ?? 0;
          expect(r.page4.opening.assets.total).toBe(priorBs.assets.total - drawings);
        }),
        { numRuns: 50 },
      );
    });
  }
});
