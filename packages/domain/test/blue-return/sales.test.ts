import { BlueReturn } from "@trebuchet/schema";
import { describe, expect, it } from "vitest";
import { buildBlueReturn } from "../../src/blue-return/build.ts";
import { formForYear } from "../../src/blue-return/form.ts";
import {
  salesWarnings,
  summarizeMonthlySales,
  summarizeSalesPartners,
} from "../../src/blue-return/sales.ts";
import { TAX_PARAMETERS } from "../../src/seed/tax-parameters.ts";
import type { ClosingNote, PostedLine } from "../../src/types.ts";
import { makeFiscalPeriod } from "../arbitraries.ts";
import { accountIdOf, INDIVIDUAL_ACCOUNT_LIST } from "../blue-return-arbitraries.ts";

const period = makeFiscalPeriod(2025);
const ROWS = formForYear(2025).salesPartnerRows;

let seq = 0;
/** 売上・雑収入の1行（相手は現金）。side = credit が通常の売上、debit は値引き・返品・訂正 */
function sale(
  date: string,
  code: "4010" | "4020",
  amount: number,
  partner: { id: string; name: string } | null = null,
  side: "credit" | "debit" = "credit",
): PostedLine[] {
  seq += 1;
  const make = (
    lineNo: number,
    s: "debit" | "credit",
    accountId: string,
    withPartner: boolean,
  ) => ({
    journalId: `j-${seq}`,
    journalNo: seq,
    date,
    memo: null,
    status: "active" as const,
    lineNo,
    side: s,
    accountId,
    accountName: "",
    subAccountId: null,
    subAccountName: null,
    amount,
    taxCategory: "OUT_OF_SCOPE" as const,
    taxAmount: 0,
    partnerId: withPartner && partner ? partner.id : null,
    partnerName: withPartner && partner ? partner.name : null,
    description: null,
  });
  const cash = accountIdOf("1010");
  const revenue = accountIdOf(code);
  return side === "credit"
    ? [make(1, "debit", cash, false), make(2, "credit", revenue, true)]
    : [make(1, "debit", revenue, true), make(2, "credit", cash, false)];
}

/** BlueReturn の schema は取引先 ID を uuid として検査する */
const UUID_A = "0000000c-0000-7000-8000-00000000000a";
const UUID_B = "0000000c-0000-7000-8000-00000000000b";
const P = (n: number) => ({ id: `partner-${n}`, name: `取引先${n}` });
const accounts = INDIVIDUAL_ACCOUNT_LIST;

describe("summarizeMonthlySales（FR-024）", () => {
  it("売上高と雑収入を月ごとに分け、借方の売上は差し引く", () => {
    const lines = [
      ...sale("2025-01-10", "4010", 100_000),
      ...sale("2025-01-20", "4010", 30_000),
      ...sale("2025-01-25", "4010", 10_000, null, "debit"),
      ...sale("2025-01-31", "4020", 2_000),
      ...sale("2025-03-01", "4010", 50_000),
      ...sale("2025-12-31", "4020", 700),
    ];
    const m = summarizeMonthlySales(lines, accounts, period);
    expect(m.months.map((x) => x.month)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(m.months[0]).toEqual({ month: 1, sales: 120_000, otherIncome: 2_000, total: 122_000 });
    expect(m.months[1]).toEqual({ month: 2, sales: 0, otherIncome: 0, total: 0 });
    expect(m.months[2]).toEqual({ month: 3, sales: 50_000, otherIncome: 0, total: 50_000 });
    expect(m.months[11]).toEqual({ month: 12, sales: 0, otherIncome: 700, total: 700 });
    expect(m.total).toEqual({ sales: 170_000, otherIncome: 2_700, total: 172_700 });
  });

  it("取消済みの行・期間外・売上以外の科目は含めない", () => {
    const voided = sale("2025-02-01", "4010", 999).map((l) => ({
      ...l,
      status: "voided" as const,
    }));
    const lines = [
      ...voided,
      ...sale("2024-12-31", "4010", 5_000),
      ...sale("2026-01-01", "4010", 6_000),
      ...sale("2025-02-02", "4010", 1_000),
    ];
    const m = summarizeMonthlySales(lines, accounts, period);
    expect(m.total).toEqual({ sales: 1_000, otherIncome: 0, total: 1_000 });
  });

  it("仕訳がなければ12か月とも 0", () => {
    const m = summarizeMonthlySales([], accounts, period);
    expect(m.months).toHaveLength(12);
    expect(m.total).toEqual({ sales: 0, otherIncome: 0, total: 0 });
  });
});

describe("summarizeSalesPartners（FR-025〜026）", () => {
  it("取引先ごとに集計し、金額の降順（同額は名前順）で様式の行数まで個別に出す", () => {
    expect(ROWS).toBe(4);
    const lines = [
      ...sale("2025-01-10", "4010", 100, P(1)),
      ...sale("2025-01-11", "4010", 500, P(2)),
      ...sale("2025-01-12", "4010", 300, P(3)),
      ...sale("2025-01-13", "4010", 300, { id: "partner-x", name: "アルファ" }),
      ...sale("2025-01-14", "4010", 50, P(4)),
      ...sale("2025-01-15", "4010", 20, P(5)),
      ...sale("2025-02-01", "4010", 200, P(2)),
    ];
    const s = summarizeSalesPartners(lines, accounts, period, ROWS);
    expect(s.rows).toEqual([
      { partnerId: "partner-2", name: "取引先2", amount: 700 },
      { partnerId: "partner-x", name: "アルファ", amount: 300 },
      { partnerId: "partner-3", name: "取引先3", amount: 300 },
      { partnerId: "partner-1", name: "取引先1", amount: 100 },
    ]);
    // 残り（取引先4・5）= 70
    expect(s.others).toBe(70);
    expect(s.total).toBe(1_470);
    expect(s.withoutPartner).toBeNull();
  });

  it("様式の行数以下なら、すべて個別で「上記以外」は 0", () => {
    const lines = [
      ...sale("2025-01-10", "4010", 100, P(1)),
      ...sale("2025-01-11", "4010", 50, P(2)),
    ];
    const s = summarizeSalesPartners(lines, accounts, period, ROWS);
    expect(s.rows.map((r) => r.amount)).toEqual([100, 50]);
    expect(s.others).toBe(0);
  });

  it("取引先のない売上は「上記以外」に含め、件数と金額を別に知らせる", () => {
    const lines = [
      ...sale("2025-01-10", "4010", 100, P(1)),
      ...sale("2025-01-11", "4010", 40_000),
      ...sale("2025-01-12", "4010", 2_500),
    ];
    const s = summarizeSalesPartners(lines, accounts, period, ROWS);
    expect(s.rows).toEqual([{ partnerId: "partner-1", name: "取引先1", amount: 100 }]);
    expect(s.others).toBe(42_500);
    expect(s.withoutPartner).toEqual({ count: 2, amount: 42_500 });
  });

  it("雑収入は個別の行に出さず「上記以外」に含める（取引先が付いていても）", () => {
    const lines = [
      ...sale("2025-01-10", "4010", 100, P(1)),
      ...sale("2025-01-11", "4020", 900, P(2)),
    ];
    const s = summarizeSalesPartners(lines, accounts, period, ROWS);
    expect(s.rows).toEqual([{ partnerId: "partner-1", name: "取引先1", amount: 100 }]);
    expect(s.others).toBe(900);
    expect(s.withoutPartner).toBeNull();
  });

  it("借方の売上（訂正）は取引先ごとに差し引く。差し引いて 0 の取引先は個別の行に出さない", () => {
    const lines = [
      ...sale("2025-01-10", "4010", 100, P(1)),
      ...sale("2025-01-11", "4010", 30, P(1), "debit"),
      ...sale("2025-01-12", "4010", 80, P(2)),
      ...sale("2025-01-13", "4010", 80, P(2), "debit"),
      ...sale("2025-01-14", "4010", 10, null, "debit"),
    ];
    const s = summarizeSalesPartners(lines, accounts, period, ROWS);
    expect(s.rows).toEqual([{ partnerId: "partner-1", name: "取引先1", amount: 70 }]);
    expect(s.others).toBe(-10);
    expect(s.withoutPartner).toEqual({ count: 1, amount: -10 });
  });

  it("同名の別の取引先は DUPLICATE_PARTNER_NAME の元（duplicateNames）に出し、別々の行にする", () => {
    const lines = [
      ...sale("2025-01-10", "4010", 100, { id: "a", name: "山田商店" }),
      ...sale("2025-01-11", "4010", 60, { id: "b", name: "山田商店" }),
      ...sale("2025-01-12", "4010", 10, P(1)),
    ];
    const s = summarizeSalesPartners(lines, accounts, period, ROWS);
    expect(s.rows.map((r) => r.partnerId)).toEqual(["a", "b", "partner-1"]);
    expect(s.duplicateNames).toEqual([{ name: "山田商店", partnerIds: ["a", "b"] }]);
  });
});

describe("salesWarnings（FR-026）", () => {
  const monthly = (total: number) => ({
    months: [],
    total: { sales: total, otherIncome: 0, total },
  });
  const partners = (rows: number, others: number) => ({
    rows: [{ partnerId: "p", name: "p", amount: rows }],
    others,
    total: rows + others,
    withoutPartner: null,
    duplicateNames: [],
  });

  it("合計が欄1と一致していれば警告なし", () => {
    expect(
      salesWarnings({ line1: 1_000, monthly: monthly(1_000), partners: partners(600, 400) }),
    ).toEqual([]);
  });

  it("月別の合計・売上先の合計が欄1と違うときは差額を SALES_TOTAL_MISMATCH で示す", () => {
    const w = salesWarnings({ line1: 1_000, monthly: monthly(900), partners: partners(600, 100) });
    expect(w.map((x) => x.code)).toEqual(["SALES_TOTAL_MISMATCH", "SALES_TOTAL_MISMATCH"]);
    expect(w[0]?.details).toMatchObject({
      target: "monthly",
      line1: 1_000,
      total: 900,
      difference: -100,
    });
    expect(w[1]?.details).toMatchObject({
      target: "partners",
      line1: 1_000,
      total: 700,
      difference: -300,
    });
    // 負の差額は 001 の formatSignedAmount と同じ書式（▲）
    expect(w[0]?.message).toContain("（900 円）が欄1（1,000 円）と一致しません（差額 ▲100 円）");
  });

  it("取引先なしの売上は件数と金額を SALES_WITHOUT_PARTNER で示す", () => {
    const w = salesWarnings({
      line1: 1_000,
      monthly: monthly(1_000),
      partners: { ...partners(600, 400), withoutPartner: { count: 3, amount: 400 } },
    });
    expect(w).toHaveLength(1);
    expect(w[0]?.code).toBe("SALES_WITHOUT_PARTNER");
    expect(w[0]?.details).toEqual({ count: 3, amount: 400 });
  });

  it("同名の別の取引先は DUPLICATE_PARTNER_NAME で名前と取引先 ID を示す", () => {
    const w = salesWarnings({
      line1: 1_000,
      monthly: monthly(1_000),
      partners: {
        ...partners(600, 400),
        duplicateNames: [{ name: "山田商店", partnerIds: ["a", "b"] }],
      },
    });
    expect(w).toHaveLength(1);
    expect(w[0]?.code).toBe("DUPLICATE_PARTNER_NAME");
    expect(w[0]?.details).toEqual({ name: "山田商店", partnerIds: ["a", "b"] });
  });
});

describe("buildBlueReturn の2・3ページ（US5）", () => {
  const build = (lines: PostedLine[], closingNotes: ClosingNote[] = []) =>
    buildBlueReturn({
      period,
      accounts,
      lines,
      deductionAnswers: null,
      taxParameters: TAX_PARAMETERS,
      closingNotes,
    });
  const line1 = (r: ReturnType<typeof build>) => r.page1.lines.find((l) => l.no === 1)?.amount;

  it("月別売上・売上先の合計は欄1と一致し、取引先なしと同名の警告を出す", () => {
    const lines = [
      ...sale("2025-01-10", "4010", 100_000, { id: UUID_A, name: "山田商店" }),
      ...sale("2025-02-10", "4010", 50_000, { id: UUID_B, name: "山田商店" }),
      ...sale("2025-03-10", "4010", 7_000),
      ...sale("2025-03-11", "4010", 1_000, null, "debit"),
      ...sale("2025-04-10", "4020", 500),
    ];
    const r = build(lines);
    expect(BlueReturn.safeParse(r).success).toBe(true);
    expect(line1(r)).toBe(156_500);
    expect(r.page2.monthly.total).toEqual({ sales: 156_000, otherIncome: 500, total: 156_500 });
    const sp = r.page3.salesPartners;
    expect(sp.rows.reduce((s, x) => s + x.amount, 0) + sp.others).toBe(156_500);
    expect(sp.others).toBe(6_000 + 500);
    expect(sp.total).toBe(156_500);
    expect(sp.withoutPartner).toEqual({ count: 2, amount: 6_000 });
    const codes = r.warnings.map((w) => w.code);
    expect(codes).toContain("SALES_WITHOUT_PARTNER");
    expect(codes).toContain("DUPLICATE_PARTNER_NAME");
    expect(codes).not.toContain("SALES_TOTAL_MISMATCH");
  });

  it("売上がない年度は警告なし、特殊事情のメモは null", () => {
    const r = build([]);
    expect(r.page3.salesPartners).toEqual({
      rows: [],
      others: 0,
      total: 0,
      withoutPartner: null,
    });
    expect(r.page3.specialCircumstances).toBeNull();
    const codes = r.warnings.map((w) => w.code);
    expect(codes).not.toContain("SALES_WITHOUT_PARTNER");
    expect(codes).not.toContain("SALES_TOTAL_MISMATCH");
    expect(codes).not.toContain("DUPLICATE_PARTNER_NAME");
  });

  it("特殊事情のメモ（special_circumstances）を3ページに含める。空のメモは null", () => {
    const note = (kind: ClosingNote["kind"], body: string): ClosingNote => ({
      fiscalYear: 2025,
      kind,
      body,
      updatedAt: "2026-01-10T00:00:00.000Z",
    });
    expect(
      build([], [note("special_circumstances", "10月に事務所を移転した")]).page3
        .specialCircumstances,
    ).toBe("10月に事務所を移転した");
    expect(
      build([], [note("opening_difference", "別のメモ")]).page3.specialCircumstances,
    ).toBeNull();
    expect(build([], [note("special_circumstances", "")]).page3.specialCircumstances).toBeNull();
  });
});
