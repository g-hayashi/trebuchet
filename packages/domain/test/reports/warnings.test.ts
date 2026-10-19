import { describe, expect, it } from "vitest";
import { computeBalances } from "../../src/reports/balances.ts";
import { detectWarnings } from "../../src/reports/warnings.ts";
import type { OpeningBalance, PostedLine } from "../../src/types.ts";
import { ACCOUNTS, accountOf, journal, LINES, OPENING, PERIOD } from "../fixtures/sample-year.ts";

const balancesOf = (lines: PostedLine[], opening: OpeningBalance[] = OPENING) =>
  computeBalances({ opening, lines, periodStart: PERIOD.startDate, to: PERIOD.endDate });

const registered = { fiscalYear: 2026, openingRegistered: true };

describe("帳票の警告（FR-033, Edge Cases）", () => {
  it("通常の残高なら警告はない（フィクスチャ）", () => {
    expect(detectWarnings(balancesOf(LINES), ACCOUNTS, registered)).toEqual([]);
  });

  it("資産の科目の残高がマイナス（売掛金 ▲15,000）なら NEGATIVE_BALANCE（科目と金額）", () => {
    const lines = [
      ...LINES,
      ...journal(40, "2026-12-31", [
        ["debit", "普通預金", 180_000],
        ["credit", "売掛金", 180_000],
      ]),
    ];
    const warnings = detectWarnings(balancesOf(lines), ACCOUNTS, registered);
    expect(warnings).toEqual([
      {
        code: "NEGATIVE_BALANCE",
        message: expect.stringContaining("売掛金"),
        details: { accountId: accountOf("売掛金").id, accountName: "売掛金", balance: -15_000 },
      },
    ]);
    expect(warnings[0]?.message).toContain("▲15,000");
  });

  it("負債の科目の残高が借方なら NEGATIVE_BALANCE", () => {
    const lines = journal(1, "2026-03-01", [
      ["debit", "未払金", 42_000],
      ["credit", "普通預金", 42_000],
    ]);
    const warnings = detectWarnings(balancesOf(lines), ACCOUNTS, registered);
    expect(warnings.map((w) => w.details)).toEqual([
      { accountId: accountOf("未払金").id, accountName: "未払金", balance: -12_000 },
    ]);
  });

  it("収益・費用・純資産の科目は、残高が逆でも警告しない", () => {
    const lines = journal(1, "2026-03-01", [
      ["debit", "売上高", 1_000],
      ["debit", "元入金", 2_000],
      ["credit", "消耗品費", 3_000],
    ]);
    expect(detectWarnings(balancesOf(lines, []), ACCOUNTS, registered)).toEqual([]);
  });

  it("補助科目ごとではなく科目の合計で判定する", () => {
    const bank = accountOf("普通預金").id;
    const lines = [
      ...journal(1, "2026-03-01", [
        ["debit", "普通預金", 5_000],
        ["credit", "売上高", 5_000],
      ]).map((l) => (l.accountId === bank ? { ...l, subAccountId: "bank-a" } : l)),
      ...journal(2, "2026-03-02", [
        ["debit", "地代家賃", 3_000],
        ["credit", "普通預金", 3_000],
      ]).map((l) => (l.accountId === bank ? { ...l, subAccountId: "bank-b" } : l)),
    ];
    expect(detectWarnings(balancesOf(lines, []), ACCOUNTS, registered)).toEqual([]);
  });

  it("期首残高が未登録なら OPENING_BALANCE_MISSING（年度つき）を先頭に出す", () => {
    const lines = journal(1, "2026-03-01", [
      ["debit", "普通預金", 1_000],
      ["credit", "売掛金", 1_000],
    ]);
    const warnings = detectWarnings(balancesOf(lines, []), ACCOUNTS, {
      fiscalYear: 2026,
      openingRegistered: false,
    });
    expect(warnings.map((w) => w.code)).toEqual(["OPENING_BALANCE_MISSING", "NEGATIVE_BALANCE"]);
    expect(warnings[0]).toEqual({
      code: "OPENING_BALANCE_MISSING",
      message: expect.stringContaining("2026"),
      details: { fiscalYear: 2026 },
    });
  });

  it("取消済みの仕訳による残高は警告の対象にしない", () => {
    const lines = journal(
      1,
      "2026-03-01",
      [
        ["debit", "普通預金", 999_000],
        ["credit", "売掛金", 999_000],
      ],
      { voided: true },
    );
    expect(detectWarnings(balancesOf(lines), ACCOUNTS, registered)).toEqual([]);
  });
});
