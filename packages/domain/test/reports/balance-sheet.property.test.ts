import { describe, expect, it } from "vitest";
import { buildBalanceSheet } from "../../src/reports/balance-sheet.ts";
import { buildProfitAndLoss } from "../../src/reports/profit-and-loss.ts";
import type { Account, PostedLine, ReportSection } from "../../src/types.ts";
import { accountSetArb, balancedOpeningArb, fc, type OpeningRow } from "../arbitraries.ts";
import {
  ACCOUNTS,
  EXPECTED_BALANCE_SHEET,
  LINES,
  OPENING,
  PERIOD,
} from "../fixtures/sample-year.ts";
import { onlyActive, PERIOD_2026, postedLinesArb, TEN_THOUSAND } from "./generators.ts";

const isBs = (a: Account) => a.reportSection.startsWith("BS_");

/** 期首残高は貸借対照表の科目だけに付ける（収益・費用は会計期間ごとに 0 から始まる） */
const inputArb = (maxLength: number, minLength = 0) =>
  accountSetArb.chain((accounts) =>
    fc.tuple(
      fc.constant(accounts),
      balancedOpeningArb(accounts.filter(isBs)),
      postedLinesArb(accounts, PERIOD_2026, { minLength, maxLength }),
      fc.integer({ min: 1, max: 12 }).map((m) => `2026-${String(m).padStart(2, "0")}-15`),
    ),
  );

const build = (accounts: Account[], opening: OpeningRow[], lines: PostedLine[], asOf: string) =>
  buildBalanceSheet({ accounts, opening, lines, periodStart: "2026-01-01", asOf });

function expectBalanced(bs: ReturnType<typeof buildBalanceSheet>) {
  const total = (section: ReportSection) =>
    bs.sections.find((s) => s.section === section)?.total.amount ?? 0;
  expect(bs.totalAssets.amount).toBe(total("BS_ASSET"));
  expect(bs.totalLiabilitiesAndEquity.amount).toBe(
    total("BS_LIABILITY") + total("BS_EQUITY") + bs.netIncome.amount,
  );
  expect(bs.totalAssets.amount).toBe(bs.totalLiabilitiesAndEquity.amount);
  expect(bs.balanced).toBe(true);
}

describe("貸借対照表（FR-029）", () => {
  it("INV-5: 任意の入力で 資産 = 負債 + 純資産 + 当期利益", () => {
    fc.assert(
      fc.property(inputArb(30), ([accounts, opening, lines, asOf]) => {
        expectBalanced(build(accounts, opening, lines, asOf));
      }),
    );
  });

  it("INV-5・SC-003: 1万件の仕訳でも貸借が一致する", () => {
    fc.assert(
      fc.property(
        inputArb(TEN_THOUSAND.maxLength, TEN_THOUSAND.minLength),
        ([accounts, opening, lines, asOf]) => {
          expectBalanced(build(accounts, opening, lines, asOf));
        },
      ),
      { numRuns: 1 },
    );
  }, 60_000);

  it("当期利益 = 損益計算書の差引金額（会計期間の開始日から基準日まで）", () => {
    fc.assert(
      fc.property(inputArb(30), ([accounts, opening, lines, asOf]) => {
        const bs = build(accounts, opening, lines, asOf);
        const pl = buildProfitAndLoss({ accounts, lines, from: "2026-01-01", to: asOf });
        expect(bs.netIncome.amount).toBe(pl.netIncome.amount);
      }),
    );
  });

  it("INV-6: 取消済みの仕訳を加えても結果が変わらない", () => {
    fc.assert(
      fc.property(inputArb(30), ([accounts, opening, lines, asOf]) => {
        expect(build(accounts, opening, lines, asOf)).toEqual(
          build(accounts, opening, onlyActive(lines), asOf),
        );
      }),
    );
  });

  it("フィクスチャの手計算の値と一致する", () => {
    const bs = buildBalanceSheet({
      accounts: ACCOUNTS,
      opening: OPENING,
      lines: LINES,
      periodStart: PERIOD.startDate,
      asOf: PERIOD.endDate,
    });
    const amounts = (section: ReportSection) =>
      Object.fromEntries(
        (bs.sections.find((s) => s.section === section)?.rows ?? [])
          .filter((r) => r.amount !== 0 || r.name === "未払金")
          .map((r) => [r.name, r.amount]),
      );
    const total = (section: ReportSection) =>
      bs.sections.find((s) => s.section === section)?.total.amount;

    expect(amounts("BS_ASSET")).toEqual(EXPECTED_BALANCE_SHEET.assets);
    expect(amounts("BS_LIABILITY")).toEqual(EXPECTED_BALANCE_SHEET.liabilities);
    expect(amounts("BS_EQUITY")).toEqual(EXPECTED_BALANCE_SHEET.equity);
    expect(total("BS_ASSET")).toBe(EXPECTED_BALANCE_SHEET.totalAssets);
    expect(total("BS_LIABILITY")).toBe(EXPECTED_BALANCE_SHEET.liabilitiesTotal);
    expect(total("BS_EQUITY")).toBe(EXPECTED_BALANCE_SHEET.equityTotal);
    expect(bs.netIncome.amount).toBe(EXPECTED_BALANCE_SHEET.netIncome);
    expect(bs.totalAssets.amount).toBe(EXPECTED_BALANCE_SHEET.totalAssets);
    expect(bs.totalLiabilitiesAndEquity.amount).toBe(
      EXPECTED_BALANCE_SHEET.totalLiabilitiesAndEquity,
    );
    expect(bs.balanced).toBe(true);
    // 区分は 資産 → 負債 → 純資産、科目は決算書の順（事業主貸は資産の末尾）
    expect(bs.sections.map((s) => s.section)).toEqual(["BS_ASSET", "BS_LIABILITY", "BS_EQUITY"]);
    expect(bs.sections[0]?.rows.at(-1)?.name).toBe("事業主貸");
  });

  it("基準日より後の仕訳は含まない", () => {
    const bs = buildBalanceSheet({
      accounts: ACCOUNTS,
      opening: OPENING,
      lines: LINES,
      periodStart: PERIOD.startDate,
      asOf: "2026-01-31",
    });
    const bank = bs.sections[0]?.rows.find((r) => r.name === "普通預金");
    // 1,000,000 + 329,560 − 80,000
    expect(bank?.amount).toBe(1_249_560);
    // 売上 330,000 − 手数料 440 − 家賃 80,000
    expect(bs.netIncome.amount).toBe(249_560);
    expect(bs.balanced).toBe(true);
  });
});
