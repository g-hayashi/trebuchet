import { describe, expect, it } from "vitest";
import { buildTrialBalance } from "../../src/reports/trial-balance.ts";
import type { Account, PostedLine } from "../../src/types.ts";
import { accountSetArb, balancedOpeningArb, fc, type OpeningRow } from "../arbitraries.ts";
import {
  ACCOUNTS,
  EXPECTED_TRIAL_BALANCE,
  EXPECTED_TRIAL_BALANCE_TOTALS,
  journal,
  LINES,
  OPENING,
  PERIOD,
} from "../fixtures/sample-year.ts";
import { onlyActive, PERIOD_2026, postedLinesArb, TEN_THOUSAND } from "./generators.ts";

const FULL_YEAR = { periodStart: "2026-01-01", from: "2026-01-01", to: "2026-12-31" };

const build = (accounts: Account[], opening: OpeningRow[], lines: PostedLine[]) =>
  buildTrialBalance({ accounts, opening, lines, ...FULL_YEAR });

const inputArb = (maxLength: number, minLength = 0) =>
  accountSetArb.chain((accounts) =>
    fc.tuple(
      fc.constant(accounts),
      balancedOpeningArb(accounts),
      postedLinesArb(accounts, PERIOD_2026, { minLength, maxLength }),
    ),
  );

function expectBalanced(tb: ReturnType<typeof buildTrialBalance>) {
  expect(tb.totals.debit).toBe(tb.totals.credit);
  expect(tb.totals.closingDebit).toBe(tb.totals.closingCredit);
  expect(tb.balanced).toBe(true);
}

describe("試算表（FR-028）", () => {
  it("INV-4: 任意の期首残高と仕訳で、借方合計 = 貸方合計", () => {
    fc.assert(
      fc.property(inputArb(30), ([accounts, opening, lines]) => {
        expectBalanced(build(accounts, opening, lines));
      }),
    );
  });

  it("INV-4・SC-003: 1万件の仕訳でも借方合計 = 貸方合計", () => {
    fc.assert(
      fc.property(inputArb(TEN_THOUSAND.maxLength, TEN_THOUSAND.minLength), ([a, o, lines]) => {
        expect(new Set(lines.map((l) => l.journalId)).size).toBe(10_000);
        expectBalanced(build(a, o, lines));
      }),
      { numRuns: 1 },
    );
  }, 60_000);

  it("INV-6: 取消済みの仕訳を加えても結果が変わらない", () => {
    fc.assert(
      fc.property(inputArb(30), ([accounts, opening, lines]) => {
        expect(build(accounts, opening, lines)).toEqual(
          build(accounts, opening, onlyActive(lines)),
        );
      }),
    );
  });

  it("期首残高は、会計期間の開始日から期間の開始日の前日までの累計を含む", () => {
    const tb = buildTrialBalance({
      accounts: ACCOUNTS,
      opening: OPENING,
      lines: LINES,
      periodStart: PERIOD.startDate,
      from: "2026-02-01",
      to: "2026-02-28",
    });
    const bank = tb.rows.find((r) => r.name === "普通預金");
    // 1,000,000 + 329,560 − 80,000（1月）
    expect(bank).toMatchObject({ opening: 1_249_560, debit: 329_560, credit: 110_000 });
    expect(bank?.closing).toBe(1_249_560 + 329_560 - 110_000);
    expectBalanced(tb);
  });

  it("フィクスチャの手計算の値と一致する（取消済みの仕訳は含まない）", () => {
    const tb = buildTrialBalance({
      accounts: ACCOUNTS,
      opening: OPENING,
      lines: LINES,
      periodStart: PERIOD.startDate,
      from: PERIOD.startDate,
      to: PERIOD.endDate,
    });
    const actual = Object.fromEntries(
      tb.rows.map((r) => [
        r.name,
        { opening: r.opening, debit: r.debit, credit: r.credit, closing: r.closing },
      ]),
    );
    expect(actual).toEqual(EXPECTED_TRIAL_BALANCE);
    expect(tb.totals).toEqual(EXPECTED_TRIAL_BALANCE_TOTALS);
    expect(tb.balanced).toBe(true);
    // 決算書の科目順（sortOrder）
    const orders = tb.rows.map((r) => ACCOUNTS.find((a) => a.id === r.accountId)?.sortOrder ?? 0);
    expect(orders).toEqual([...orders].sort((x, y) => x - y));
  });

  it("期間外の仕訳（前年度・期間の終了日より後）は含まない", () => {
    const tb = buildTrialBalance({
      accounts: ACCOUNTS,
      opening: OPENING,
      lines: [
        ...journal(100, "2025-12-31", [
          ["debit", "売掛金", 99_000],
          ["credit", "売上高", 99_000],
        ]),
        ...LINES,
      ],
      periodStart: PERIOD.startDate,
      from: PERIOD.startDate,
      to: "2026-01-31",
    });
    const sales = tb.rows.find((r) => r.name === "売上高");
    expect(sales).toMatchObject({ opening: 0, credit: 330_000, closing: 330_000 });
    expect(tb.rows.find((r) => r.name === "雑収入")).toBeUndefined();
  });
});
