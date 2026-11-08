import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addDays, dateInMonth, daysBetween, monthEnd, yearOfDate } from "../../src/dates.ts";
import {
  buildDemoPlan,
  type DemoLine,
  type DemoPlan,
  demoEntityName,
} from "../../src/demo/plan.ts";
import { INDIVIDUAL_ACCOUNTS } from "../../src/seed/accounts.individual.ts";

// INV-76（014 data-model §4）: 任意の作成日 today について、計画の日付はすべて today 以下で
// fiscalYear の年に収まり、spec US1 の 3 の 11 種がそれぞれ 1 件以上あり、各仕訳は貸借一致、金額は整数

const FIRST_DAY = "2000-01-01";
const LAST_DAY = "2100-12-31";
const arbToday = fc
  .integer({ min: 0, max: daysBetween(FIRST_DAY, LAST_DAY) })
  .map((n) => addDays(FIRST_DAY, n));

const ACCOUNT_NAMES = new Set(INDIVIDUAL_ACCOUNTS.map((a) => a.name));

/** 計画に入っている日付すべて（期首を除く。明細の CSV は日付の欄を読む） */
function allDates(plan: DemoPlan): string[] {
  const dates: string[] = [];
  for (const j of plan.journals) dates.push(j.date);
  for (const c of plan.corrections) dates.push(c.date);
  for (const a of plan.fixedAssets) dates.push(a.acquiredOn);
  for (const d of plan.deferredAssets) dates.push(d.openedOn);
  dates.push(dateInMonth(plan.recurring.startMonth, plan.recurring.dayOfMonth));
  for (const w of plan.invoicing.workHours) dates.push(monthEnd(w.month));
  for (const i of plan.invoicing.invoices) {
    dates.push(i.issueDate);
    if (i.payment !== undefined) dates.push(i.payment.receivedOn);
  }
  for (const r of plan.receipts) dates.push(r.date);
  for (const row of statementRows(plan)) dates.push(row.date);
  return dates;
}

/** 明細の CSV（見出しの次の行から）。日付は `YYYY/MM/DD` */
function statementRows(plan: DemoPlan) {
  const [header, ...rows] = plan.statement.csv.trim().split("\n");
  expect(header).toBeDefined();
  return rows.map((line) => {
    const cells = line.split(",").map((c) => c.replace(/^"|"$/g, ""));
    return {
      date: (cells[0] ?? "").replaceAll("/", "-"),
      content: cells[1] ?? "",
      outflow: cells[2] ?? "",
      inflow: cells[3] ?? "",
    };
  });
}

const isYen = (n: number) => Number.isInteger(n) && n > 0 && n < 1e12;

function sumBy(lines: readonly DemoLine[], side: "debit" | "credit"): number {
  return lines.filter((l) => l.side === side).reduce((s, l) => s + l.amount, 0);
}

function expectInvariant(today: string): void {
  const plan = buildDemoPlan(today);
  const month = Number(today.slice(5, 7));
  // 年度: 3 月以降は今年、1・2 月は前の年
  expect(plan.fiscalYear).toBe(yearOfDate(today) - (month >= 3 ? 0 : 1));

  // 日付: すべて作成日以下で、年度の年に収まる
  for (const date of allDates(plan)) {
    expect(daysBetween(date, today)).toBeGreaterThanOrEqual(0);
    expect(yearOfDate(date)).toBe(plan.fiscalYear);
  }

  // 参照の整合: 科目・補助科目・取引先・仕訳の key
  const subNames = new Set(plan.subAccounts.map((s) => s.name));
  const partnerNames = new Set(plan.partners.map((p) => p.name));
  const keys = plan.journals.map((j) => j.key);
  expect(new Set(keys).size).toBe(keys.length);
  const allLines: DemoLine[] = [
    ...plan.openingBalances.map((o) => ({ ...o, side: o.side })),
    ...plan.journals.flatMap((j) => j.lines),
    ...plan.corrections.flatMap((c) => c.lines),
    ...plan.recurring.lines,
  ];
  for (const l of allLines) {
    expect(ACCOUNT_NAMES.has(l.account)).toBe(true);
    if (l.sub !== undefined) expect(subNames.has(l.sub)).toBe(true);
    if (l.partner !== undefined) expect(partnerNames.has(l.partner)).toBe(true);
    expect(isYen(l.amount)).toBe(true);
  }

  // 貸借一致（期首・各仕訳・訂正後・定期仕訳）
  expect(sumBy(plan.openingBalances, "debit")).toBe(sumBy(plan.openingBalances, "credit"));
  for (const j of plan.journals) expect(sumBy(j.lines, "debit")).toBe(sumBy(j.lines, "credit"));
  for (const c of plan.corrections) expect(sumBy(c.lines, "debit")).toBe(sumBy(c.lines, "credit"));
  expect(sumBy(plan.recurring.lines, "debit")).toBe(sumBy(plan.recurring.lines, "credit"));

  // 11 種がそれぞれ 1 件以上
  expect(plan.openingBalances.length).toBeGreaterThan(0); // 1 期首残高
  expect(plan.subAccounts.length).toBeGreaterThan(0); // 2 補助科目
  expect(plan.partners.length).toBeGreaterThan(0); // 3 取引先
  expect(plan.partners.filter((p) => p.billingTerms?.withholding === true)).toHaveLength(1); //  うち源泉徴収 1
  expect(plan.journals.length).toBeGreaterThan(0); // 4 仕訳
  expect(plan.corrections.length).toBeGreaterThan(0); //  訂正
  expect(plan.voids.length).toBeGreaterThan(0); //  取消
  for (const c of plan.corrections) expect(keys).toContain(c.key);
  for (const v of plan.voids) expect(keys).toContain(v.key);
  expect(plan.homeUse.length).toBeGreaterThan(0); // 5 家事按分
  expect(plan.fixedAssets.map((a) => a.method).sort()).toEqual([
    "lump_sum",
    "small_asset_28_2",
    "straight_line",
  ]); // 6 固定資産 3 種
  for (const a of plan.fixedAssets) {
    expect(isYen(a.acquisitionCost)).toBe(true);
    if (a.linkedJournalKey !== undefined) expect(keys).toContain(a.linkedJournalKey);
  }
  expect(plan.deferredAssets.length).toBeGreaterThan(0); // 7 開業費
  expect(daysBetween(dateInMonth(plan.recurring.startMonth, plan.recurring.dayOfMonth), today)) // 8 定期仕訳と計上分
    .toBeGreaterThanOrEqual(0);
  const invoices = plan.invoicing.invoices;
  const withholdingPartner = plan.partners.find((p) => p.billingTerms?.withholding === true);
  expect(invoices.some((i) => i.payment !== undefined && i.partner === withholdingPartner?.name)) // 9 請求書
    .toBe(true);
  expect(invoices.some((i) => i.payment === undefined)).toBe(true);
  for (const i of invoices) {
    expect(
      plan.invoicing.workHours.some((w) => w.month === i.month && w.partner === i.partner),
    ).toBe(true);
  }
  expect(plan.receipts.length).toBeGreaterThan(0); // 10 証憑
  for (const r of plan.receipts) {
    expect(keys).toContain(r.journalKey);
    expect(isYen(r.amount)).toBe(true);
  }
  expect(statementRows(plan).length).toBeGreaterThan(0); // 11 未処理の明細
  expect(plan.statement.mapping.columns).toEqual({ date: 0, content: 1, outflow: 2, inflow: 3 });
}

describe("buildDemoPlan（INV-76）", () => {
  it("任意の作成日で、日付は作成日以下・年度内、11 種が揃い、貸借が一致する", () => {
    fc.assert(
      fc.property(arbToday, (today) => {
        expectInvariant(today);
      }),
      { numRuns: 300 },
    );
  });

  it("2026-11-08: 年度は 2026 で、日付は 2026-11-08 以下", () => {
    const plan = buildDemoPlan("2026-11-08");
    expect(plan.fiscalYear).toBe(2026);
    expectInvariant("2026-11-08");
    // 3 月以降は量が増える（1・2 月だけの作成日より多い）
    expect(plan.journals.length).toBeGreaterThan(buildDemoPlan("2026-03-01").journals.length);
  });

  it("2026-03-01: 年度は 2026（3 月 1 日は今年）。作成日ちょうどの日付は含んでよい", () => {
    expect(buildDemoPlan("2026-03-01").fiscalYear).toBe(2026);
    expectInvariant("2026-03-01");
  });

  it("2026-01-15: 年度は前の年の 2025 で、日付はすべて 2025 年", () => {
    const plan = buildDemoPlan("2026-01-15");
    expect(plan.fiscalYear).toBe(2025);
    expectInvariant("2026-01-15");
    expect(plan.journals.length).toBeGreaterThan(buildDemoPlan("2026-03-01").journals.length);
  });

  it("2026-02-28 も前の年、2024-02-29（うるう日）も前の年", () => {
    expect(buildDemoPlan("2026-02-28").fiscalYear).toBe(2025);
    expect(buildDemoPlan("2024-02-29").fiscalYear).toBe(2023);
    expectInvariant("2024-02-29");
  });

  it("同じ作成日なら同じ計画（純関数）", () => {
    expect(buildDemoPlan("2026-11-08")).toEqual(buildDemoPlan("2026-11-08"));
  });
});

describe("demoEntityName（名前の重なり）", () => {
  it("同名がなければ既定の名前", () => {
    expect(demoEntityName([])).toBe("デモ事業（サンプル）");
    expect(demoEntityName(["本業", "副業"])).toBe("デモ事業（サンプル）");
  });

  it("重なるときは、空いている最小の番号を付ける（2 から）", () => {
    expect(demoEntityName(["デモ事業（サンプル）"])).toBe("デモ事業（サンプル 2）");
    expect(demoEntityName(["デモ事業（サンプル）", "デモ事業（サンプル 2）"])).toBe(
      "デモ事業（サンプル 3）",
    );
    expect(demoEntityName(["デモ事業（サンプル）", "デモ事業（サンプル 3）"])).toBe(
      "デモ事業（サンプル 2）",
    );
  });

  it("任意の既存の名前の集合に対し、結果は既存と重ならず『デモ』を含む", () => {
    const arbName = fc.oneof(
      fc.constantFrom(
        "デモ事業（サンプル）",
        "デモ事業（サンプル 2）",
        "デモ事業（サンプル 3）",
        "デモ事業（サンプル 4）",
      ),
      fc.string({ maxLength: 8 }),
    );
    fc.assert(
      fc.property(fc.array(arbName, { maxLength: 8 }), (existing) => {
        const name = demoEntityName(existing);
        expect(existing).not.toContain(name);
        expect(name).toContain("デモ");
      }),
    );
  });
});
