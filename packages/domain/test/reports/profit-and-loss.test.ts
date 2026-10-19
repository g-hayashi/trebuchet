import { describe, expect, it } from "vitest";
import { buildProfitAndLoss, compareProfitAndLoss } from "../../src/reports/profit-and-loss.ts";
import type { Account } from "../../src/types.ts";
import {
  ACCOUNTS,
  EXPECTED_PROFIT_AND_LOSS,
  journal,
  LINES,
  PERIOD,
} from "../fixtures/sample-year.ts";

const section = (pl: ReturnType<typeof buildProfitAndLoss>, s: string) =>
  pl.sections.find((x) => x.section === s);

const nonZero = (rows: { name: string; amount: number }[] = []) =>
  Object.fromEntries(rows.filter((r) => r.amount !== 0).map((r) => [r.name, r.amount]));

const current = buildProfitAndLoss({
  accounts: ACCOUNTS,
  lines: LINES,
  from: PERIOD.startDate,
  to: PERIOD.endDate,
});

describe("損益計算書（FR-029）", () => {
  it("フィクスチャの手計算の値と一致する（売上・経費の合計と差引金額）", () => {
    expect(nonZero(section(current, "PL_SALES")?.rows)).toEqual(EXPECTED_PROFIT_AND_LOSS.sales);
    expect(section(current, "PL_SALES")?.total.amount).toBe(EXPECTED_PROFIT_AND_LOSS.salesTotal);
    expect(nonZero(section(current, "PL_EXPENSE")?.rows)).toEqual(
      EXPECTED_PROFIT_AND_LOSS.expenses,
    );
    expect(section(current, "PL_EXPENSE")?.total.amount).toBe(
      EXPECTED_PROFIT_AND_LOSS.expensesTotal,
    );
    expect(current.netIncome.amount).toBe(EXPECTED_PROFIT_AND_LOSS.netIncome);
    expect(current.previous).toBeNull();
  });

  it("決算書の科目順: 売上 → 経費の区分、経費は欄番号の順（地代家賃は ㉓）", () => {
    expect(current.sections.map((s) => s.section)).toEqual(["PL_SALES", "PL_EXPENSE"]);
    const expenses = section(current, "PL_EXPENSE")?.rows ?? [];
    const lines = expenses.map((r) => r.reportLine ?? 0);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
    expect(expenses.find((r) => r.name === "地代家賃")?.reportLine).toBe(23);
    // 使用中の科目は金額が 0 でも表示する
    expect(expenses.find((r) => r.name === "租税公課")?.amount).toBe(0);
  });

  it("期間の外の仕訳と取消済みの仕訳は含まない", () => {
    const q1 = buildProfitAndLoss({
      accounts: ACCOUNTS,
      lines: LINES,
      from: "2026-04-01",
      to: "2026-04-30",
    });
    expect(nonZero(section(q1, "PL_SALES")?.rows)).toEqual({ 売上高: 330_000 });
    expect(nonZero(section(q1, "PL_EXPENSE")?.rows)).toEqual({
      通信費: 8_800,
      地代家賃: 80_000,
      支払手数料: 440,
    });
    const sep = buildProfitAndLoss({
      accounts: ACCOUNTS,
      lines: LINES,
      from: "2026-09-01",
      to: "2026-09-30",
    });
    expect(section(sep, "PL_EXPENSE")?.total.amount).toBe(0);
  });

  describe("前年比較（FR-030）", () => {
    const training = ACCOUNTS.find((a) => a.name === "研修費") as Account;
    const accounts = ACCOUNTS.map((a) => (a.id === training.id ? { ...a, isActive: false } : a));
    const previousLines = [
      ...journal(1, "2025-06-30", [
        ["debit", "売掛金", 1_000_000],
        ["credit", "売上高", 1_000_000],
      ]),
      ...journal(2, "2025-07-25", [
        ["debit", "地代家賃", 960_000],
        ["credit", "普通預金", 960_000],
      ]),
      ...journal(3, "2025-08-01", [
        ["debit", "研修費", 5_000],
        ["credit", "現金", 5_000],
      ]),
    ];
    const previous = buildProfitAndLoss({
      accounts,
      lines: previousLines,
      from: "2025-01-01",
      to: "2025-12-31",
    });
    const cur = buildProfitAndLoss({
      accounts,
      lines: LINES,
      from: PERIOD.startDate,
      to: PERIOD.endDate,
    });
    const compared = compareProfitAndLoss(cur, previous, accounts);
    const row = (s: string, name: string) =>
      section(compared, s)?.rows.find((r) => r.name === name);

    it("US4-4: 科目ごとに 当年・前年・増減（= 当年 − 前年）を表示する", () => {
      expect(row("PL_SALES", "売上高")).toMatchObject({
        amount: 2_145_000,
        previous: 1_000_000,
        change: 1_145_000,
      });
      expect(row("PL_EXPENSE", "地代家賃")).toMatchObject({
        amount: 560_000,
        previous: 960_000,
        change: -400_000,
      });
      expect(compared.previous).toEqual({ from: "2025-01-01", to: "2025-12-31" });
    });

    it("前年のデータがない科目は前年 0、当年のデータがない科目は当年 0", () => {
      expect(row("PL_SALES", "雑収入")).toMatchObject({
        amount: 1_200,
        previous: 0,
        change: 1_200,
      });
      // 使用停止の科目も、前年に金額があれば表示する
      expect(row("PL_EXPENSE", "研修費")).toMatchObject({
        amount: 0,
        previous: 5_000,
        change: -5_000,
      });
    });

    it("区分の合計と差引金額にも前年と増減を付ける", () => {
      expect(section(compared, "PL_SALES")?.total).toEqual({
        amount: 2_146_200,
        previous: 1_000_000,
        change: 1_146_200,
      });
      expect(compared.netIncome).toEqual({
        amount: 1_553_520,
        previous: 1_000_000 - 965_000,
        change: 1_553_520 - 35_000,
      });
      for (const s of compared.sections) {
        for (const r of s.rows) expect(r.change).toBe(r.amount - (r.previous ?? 0));
      }
    });

    it("使用停止で両年とも 0 の科目は表示しない", () => {
      const cmp = compareProfitAndLoss(
        cur,
        buildProfitAndLoss({ accounts, lines: [], from: "2025-01-01", to: "2025-12-31" }),
        accounts,
      );
      expect(section(cmp, "PL_EXPENSE")?.rows.find((r) => r.name === "研修費")).toBeUndefined();
    });
  });
});
