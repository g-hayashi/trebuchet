import { BlueReturn } from "@trebuchet/schema";
import { describe, expect, it } from "vitest";
import { buildBlueReturn } from "../../src/blue-return/build.ts";
import { formForYear } from "../../src/blue-return/form.ts";
import { STRAIGHT_LINE_RATES } from "../../src/seed/depreciation-rates.ts";
import { TAX_PARAMETERS } from "../../src/seed/tax-parameters.ts";
import type { Account, DeductionAnswers, PostedLine } from "../../src/types.ts";
import { makeAccount, makeFiscalPeriod } from "../arbitraries.ts";
import { accountIdOf, INDIVIDUAL_ACCOUNT_LIST } from "../blue-return-arbitraries.ts";

const period = makeFiscalPeriod(2025);

let seq = 0;
/** 仕訳 1 件（借方・貸方の 2 行）を作る */
function entry(
  date: string,
  debit: string,
  credit: string,
  amount: number,
  accounts: readonly Account[] = INDIVIDUAL_ACCOUNT_LIST,
): PostedLine[] {
  seq += 1;
  const name = (id: string) => accounts.find((a) => a.id === id)?.name ?? "";
  return (["debit", "credit"] as const).map((side, i) => {
    const accountId = side === "debit" ? debit : credit;
    return {
      journalId: `j-${seq}`,
      journalNo: seq,
      date,
      memo: null,
      status: "active",
      lineNo: i + 1,
      side,
      accountId,
      accountName: name(accountId),
      subAccountId: null,
      subAccountName: null,
      amount,
      taxCategory: "OUT_OF_SCOPE",
      taxAmount: 0,
      partnerId: null,
      partnerName: null,
      description: null,
    };
  });
}

const cash = accountIdOf("1010");
const bookLines = (
  rows: readonly (readonly [code: string, amount: number])[],
  accounts?: readonly Account[],
) =>
  rows.flatMap(([code, amount]) =>
    code.startsWith("4")
      ? entry("2025-06-30", cash, accountIdOf(code), amount, accounts)
      : entry("2025-06-30", accountIdOf(code), cash, amount, accounts),
  );

const answers = (over: Partial<DeductionAnswers> = {}): DeductionAnswers => ({
  fiscalYear: 2025,
  doubleEntry: true,
  statementsAttached: true,
  filedOnTime: true,
  eTax: true,
  electronicBooks: false,
  updatedAt: "2026-01-10T00:00:00.000Z",
  ...over,
});

const build = (
  lines: PostedLine[],
  over: { deductionAnswers?: DeductionAnswers | null; accounts?: readonly Account[] } = {},
) =>
  buildBlueReturn({
    period,
    accounts: over.accounts ?? INDIVIDUAL_ACCOUNT_LIST,
    lines,
    deductionAnswers: over.deductionAnswers === undefined ? answers() : over.deductionAnswers,
    taxParameters: TAX_PARAMETERS,
    straightLineRates: STRAIGHT_LINE_RATES,
  });

const amountOf = (r: ReturnType<typeof build>, no: number) =>
  r.page1.lines.find((l) => l.no === no)?.amount;
const labelOf = (r: ReturnType<typeof build>, no: number) =>
  r.page1.lines.find((l) => l.no === no)?.label;
/** 期首残高なしで経費を現金で払うと現金が負になる（4ページの NEGATIVE_BALANCE）。1ページの警告だけを見る */
const withoutNegativeBalance = (r: ReturnType<typeof build>) =>
  r.warnings.filter((w) => w.code !== "NEGATIVE_BALANCE");
/** このテストの帳簿は取引先を付けないので出る SALES_WITHOUT_PARTNER（US5）を除く */
const withoutSalesWarnings = (r: ReturnType<typeof build>) =>
  r.warnings.filter((w) => w.code !== "SALES_WITHOUT_PARTNER");

// 売上 1,000,000、雑収入 20,000、経費 59,000（任意科目 2 つを含む）
const smallBook = bookLines([
  ["4010", 1_000_000],
  ["4020", 20_000],
  ["5080", 30_000],
  ["5120", 12_000],
  ["5170", 8_000],
  ["5250", 5_000],
  ["5260", 3_000],
  ["5310", 1_000],
]);

describe("buildBlueReturn 1ページ（R1）", () => {
  it("様式の年分・年度・状態を入れる", () => {
    const r = build(smallBook);
    expect(r.fiscalYear).toBe(2025);
    expect(r.formYear).toBe(formForYear(2025).year);
    expect(r.status).toBe("open");
    const closed = buildBlueReturn({
      period: { ...period, status: "closed", closedAt: "2026-03-01T00:00:00.000Z" },
      accounts: INDIVIDUAL_ACCOUNT_LIST,
      lines: smallBook,
      deductionAnswers: answers(),
      taxParameters: TAX_PARAMETERS,
      straightLineRates: STRAIGHT_LINE_RATES,
    });
    expect(closed.status).toBe("closed");
  });

  it("欄1〜45 を番号順に並べ、欄名は様式のもの", () => {
    const r = build(smallBook);
    expect(r.page1.lines.map((l) => l.no)).toEqual(Array.from({ length: 45 }, (_, i) => i + 1));
    expect(labelOf(r, 1)).toBe("売上（収入）金額（雑収入を含む）");
    expect(labelOf(r, 8)).toBe("租税公課");
    expect(labelOf(r, 31)).toBe("雑費");
    expect(labelOf(r, 32)).toBe("計");
  });

  it("各欄に様式の kind（account / optional / computed / unused）を入れる", () => {
    const r = build(smallBook);
    const form = formForYear(2025);
    expect(r.page1.lines.map((l) => [l.no, l.kind])).toEqual(form.pl.map((f) => [f.no, f.kind]));
    const kindOf = (no: number) => r.page1.lines.find((l) => l.no === no)?.kind;
    expect(kindOf(1)).toBe("account");
    expect(kindOf(2)).toBe("unused");
    expect(kindOf(25)).toBe("optional");
    expect(kindOf(33)).toBe("computed");
    expect(kindOf(42)).toBe("unused");
  });

  it("科目の欄と計算の欄（売上と雑収入は欄1、経費計、差引金額、欄43〜45）", () => {
    const r = build(smallBook);
    expect(amountOf(r, 1)).toBe(1_020_000);
    expect(amountOf(r, 8)).toBe(30_000);
    expect(amountOf(r, 12)).toBe(12_000);
    expect(amountOf(r, 17)).toBe(8_000);
    expect(amountOf(r, 31)).toBe(1_000);
    expect(amountOf(r, 9)).toBe(0);
    expect(amountOf(r, 32)).toBe(59_000);
    expect(amountOf(r, 33)).toBe(961_000);
    expect(amountOf(r, 43)).toBe(961_000);
    expect(amountOf(r, 44)).toBe(650_000);
    expect(amountOf(r, 45)).toBe(311_000);
    expect(r.transfer).toEqual({ businessIncome: 311_000, blueDeduction: 650_000 });
    expect(r.page2.deduction).toEqual({ cap: 650_000, tier: "max", unmet: [], amount: 650_000 });
    expect(withoutSalesWarnings(r)).toEqual([]);
  });

  it("任意科目は欄25から科目名つきで詰める。残りの任意欄は名前なしの 0", () => {
    const r = build(smallBook);
    expect(labelOf(r, 25)).toBe("支払手数料");
    expect(amountOf(r, 25)).toBe(5_000);
    expect(labelOf(r, 26)).toBe("会議費");
    expect(amountOf(r, 26)).toBe(3_000);
    for (const no of [27, 28, 29, 30]) {
      expect(labelOf(r, no)).toBe("");
      expect(amountOf(r, no)).toBe(0);
    }
  });

  it("reportLine が一般の欄にない費用の科目（null）も任意欄に入る", () => {
    const extra = makeAccount("expense", {
      id: "0000000a-0000-7000-8000-000000009001",
      code: "5901",
      name: "車両費",
      reportSection: "PL_EXPENSE",
      reportLine: null,
      sortOrder: 6999,
    });
    const accounts = [...INDIVIDUAL_ACCOUNT_LIST, extra];
    const lines = entry("2025-03-01", extra.id, cash, 7_000, accounts);
    const r = build(lines, { accounts });
    expect(labelOf(r, 25)).toBe("車両費");
    expect(amountOf(r, 25)).toBe(7_000);
    expect(amountOf(r, 32)).toBe(7_000);
    expect(withoutNegativeBalance(r)).toEqual([]);
  });

  it("使わない欄（原価の欄2〜7、引当金等の欄34〜42）は常に 0（空欄にしない）", () => {
    const r = build(smallBook);
    const unused = formForYear(2025)
      .pl.filter((l) => l.kind === "unused")
      .map((l) => l.no);
    expect(unused.length).toBeGreaterThan(0);
    for (const no of unused) {
      expect(amountOf(r, no), `欄${no}`).toBe(0);
    }
    for (const l of r.page1.lines) expect(l.amount).not.toBeNull();
  });

  it("任意科目が7つで OPTIONAL_LINES_OVERFLOW（6つまでは欄に出し、7つ目は出さない）", () => {
    const extras = [5901, 5902].map((n, i) =>
      makeAccount("expense", {
        id: `0000000a-0000-7000-8000-00000000${n}`,
        code: String(n),
        name: `追加科目${i + 1}`,
        reportSection: "PL_EXPENSE",
        reportLine: i === 0 ? null : 30,
        sortOrder: 6900 + i,
      }),
    );
    const accounts = [...INDIVIDUAL_ACCOUNT_LIST, ...extras];
    const lines = [
      ...bookLines(
        [
          ["5250", 1_000],
          ["5260", 2_000],
          ["5270", 3_000],
          ["5280", 4_000],
          ["5290", 5_000],
        ],
        accounts,
      ),
      ...extras.flatMap((a, i) => entry("2025-04-01", a.id, cash, 6_000 + i, accounts)),
    ];
    const r = build(lines, { accounts });
    const overflow = r.warnings.find((w) => w.code === "OPTIONAL_LINES_OVERFLOW");
    expect(overflow).toBeDefined();
    expect(overflow?.details).toMatchObject({
      count: 7,
      omitted: [{ accountId: extras[1]?.id, name: "追加科目2", amount: 6_001 }],
    });
    expect([25, 26, 27, 28, 29, 30].map((no) => labelOf(r, no))).toEqual([
      "支払手数料",
      "会議費",
      "新聞図書費",
      "諸会費",
      "研修費",
      "追加科目1",
    ]);
    // あふれた科目も欄32・33・43 に含める（金額を落とさない。INV-18）。PL_MISMATCH は出さない
    expect(amountOf(r, 32)).toBe(1_000 + 2_000 + 3_000 + 4_000 + 5_000 + 6_000 + 6_001);
    expect(amountOf(r, 33)).toBe(0 - (amountOf(r, 32) as number));
    expect(amountOf(r, 43)).toBe(amountOf(r, 33));
    expect(r.warnings.some((w) => w.code === "PL_MISMATCH")).toBe(false);
  });

  it("任意科目が6つまでなら警告なし", () => {
    const lines = bookLines([
      ["5250", 1_000],
      ["5260", 2_000],
      ["5270", 3_000],
      ["5280", 4_000],
      ["5290", 5_000],
    ]);
    const r = build(lines);
    expect(withoutNegativeBalance(r).map((w) => w.code)).toEqual([]);
  });

  it("金額が 0 の任意科目は欄を取らない", () => {
    const r = build(bookLines([["4010", 10_000]]));
    expect(labelOf(r, 25)).toBe("");
    expect(withoutSalesWarnings(r)).toEqual([]);
  });

  it("取消済みの仕訳と期間外の日付は含めない", () => {
    const voided = entry("2025-05-01", accountIdOf("5120"), cash, 99_000).map((l) => ({
      ...l,
      status: "voided" as const,
    }));
    const outside = entry("2026-01-05", accountIdOf("5120"), cash, 77_000);
    const r = build([...smallBook, ...voided, ...outside]);
    expect(amountOf(r, 12)).toBe(12_000);
  });

  it("控除の回答がなければ欄44・45 と transfer は null、DEDUCTION_ANSWERS_MISSING", () => {
    const r = build(smallBook, { deductionAnswers: null });
    expect(amountOf(r, 43)).toBe(961_000);
    expect(amountOf(r, 44)).toBeNull();
    expect(amountOf(r, 45)).toBeNull();
    expect(r.transfer).toEqual({ businessIncome: null, blueDeduction: null });
    expect(r.page2.deduction).toBeNull();
    expect(withoutSalesWarnings(r).map((w) => w.code)).toEqual(["DEDUCTION_ANSWERS_MISSING"]);
  });

  it("欄43 が負なら控除は 0、所得金額は欄43 のまま", () => {
    const r = build(bookLines([["5120", 40_000]]));
    expect(amountOf(r, 43)).toBe(-40_000);
    expect(amountOf(r, 44)).toBe(0);
    expect(amountOf(r, 45)).toBe(-40_000);
  });

  it("控除の上限は回答で決まる（基本の 10 万円）", () => {
    const r = build(smallBook, { deductionAnswers: answers({ doubleEntry: false }) });
    expect(r.page2.deduction?.tier).toBe("basic");
    expect(r.page2.deduction?.amount).toBe(100_000);
    expect(r.page2.deduction?.unmet).toEqual(["正規の簿記の原則による記帳"]);
    expect(amountOf(r, 44)).toBe(100_000);
    expect(amountOf(r, 45)).toBe(861_000);
  });

  it("2・3ページは schema の BlueReturn に合う（取引先なしの売上は「上記以外」に入る。詳細は sales.test.ts）", () => {
    const r = build(smallBook);
    expect(r.page2.monthly.months).toHaveLength(12);
    expect(r.page2.monthly.total.total).toBe(1_020_000);
    expect(r.page2.rentDetails).toEqual([]);
    expect(r.page3.depreciation).toEqual([]);
    expect(r.page3.salesPartners.rows).toEqual([]);
    expect(r.page3.salesPartners.others).toBe(1_020_000);
    expect(r.page3.salesPartners.total).toBe(1_020_000);
    expect(r.page3.salesPartners.withoutPartner).toEqual({ count: 1, amount: 1_000_000 });
    expect(BlueReturn.safeParse(r).success).toBe(true);
  });
});
