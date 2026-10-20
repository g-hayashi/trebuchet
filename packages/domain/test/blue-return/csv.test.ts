import type { BlueReturn } from "@trebuchet/schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildBlueReturn } from "../../src/blue-return/build.ts";
import { blueReturnToCsv } from "../../src/blue-return/csv.ts";
import { formForYear } from "../../src/blue-return/form.ts";
import { parseCsv } from "../../src/import/csv.ts";
import { TAX_PARAMETERS } from "../../src/seed/tax-parameters.ts";
import type { DeductionAnswers } from "../../src/types.ts";
import { yearLedgerArb } from "../blue-return-arbitraries.ts";

const answers: DeductionAnswers = {
  fiscalYear: 2025,
  doubleEntry: true,
  statementsAttached: true,
  filedOnTime: true,
  eTax: true,
  electronicBooks: false,
  updatedAt: "2026-01-10T00:00:00.000Z",
};

/** BOM を除いて読み戻す */
const read = (csv: string) => {
  expect(csv.startsWith("﻿")).toBe(true);
  return parseCsv(csv.slice(1));
};

const unusedNos = new Set(
  formForYear(2025)
    .pl.filter((l) => l.kind === "unused")
    .map((l) => l.no),
);

describe("blueReturnToCsv（R14）", () => {
  it("見出しは ページ,欄番号,欄名,金額。CRLF で終える", () => {
    const csv = blueReturnToCsv(
      buildBlueReturn({
        period: { ...yearPeriod(), status: "open" },
        accounts: [],
        lines: [],
        deductionAnswers: answers,
        taxParameters: TAX_PARAMETERS,
      }),
      { blankUnused: false },
    );
    expect(read(csv)[0]).toEqual(["ページ", "欄番号", "欄名", "金額"]);
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("読み戻した金額が blueReturn の1ページの欄と一致する（回答なしの null は空）", () => {
    fc.assert(
      fc.property(
        yearLedgerArb,
        fc.option(fc.constant(answers), { nil: null }),
        (ledger, deductionAnswers) => {
          const r = buildBlueReturn({
            period: ledger.period,
            accounts: ledger.accounts,
            lines: ledger.lines,
            deductionAnswers,
            taxParameters: TAX_PARAMETERS,
          });
          const rows = read(blueReturnToCsv(r, { blankUnused: false })).slice(1);
          const page1 = rows.filter((row) => row[0] === "1");
          expect(page1).toHaveLength(r.page1.lines.length);
          for (const [i, l] of r.page1.lines.entries()) {
            const row = page1[i] as string[];
            expect(row[1]).toBe(String(l.no));
            expect(row[2]).toBe(l.label);
            expect(row[3]).toBe(l.amount === null ? "" : String(l.amount));
          }
        },
      ),
    );
  });

  it("blankUnused で unused の欄の金額だけが空になる", () => {
    const ledger = fc.sample(yearLedgerArb, { numRuns: 1, seed: 1 })[0];
    if (ledger === undefined) throw new Error("no ledger");
    const r = buildBlueReturn({
      period: ledger.period,
      accounts: ledger.accounts,
      lines: ledger.lines,
      deductionAnswers: answers,
      taxParameters: TAX_PARAMETERS,
    });
    const shown = read(blueReturnToCsv(r, { blankUnused: false })).slice(1);
    const blank = read(blueReturnToCsv(r, { blankUnused: true })).slice(1);
    expect(blank).toHaveLength(shown.length);
    for (const [i, row] of blank.entries()) {
      const before = shown[i] as string[];
      const no = Number(row[1]);
      if (row[0] === "1" && unusedNos.has(no)) {
        expect(before[3], `欄${no}`).toBe("0");
        expect(row[3], `欄${no}`).toBe("");
      } else {
        expect(row, `欄${no}`).toEqual(before);
      }
    }
    // unused 以外の 0 は空にならない（任意欄の 0 など）
    const optional = blank.find((row) => row[0] === "1" && row[1] === "30");
    expect(optional?.[3]).toBe("0");
  });

  it("blankUnused は各欄の kind で判定する（kind が unused の欄だけ空になる）", () => {
    const base = buildBlueReturn({
      period: yearPeriod(),
      accounts: [],
      lines: [],
      deductionAnswers: answers,
      taxParameters: TAX_PARAMETERS,
    });
    const r = {
      ...base,
      page1: {
        lines: base.page1.lines.map((l) =>
          l.no === 8
            ? { ...l, kind: "unused" as const }
            : l.no === 2
              ? { ...l, kind: "account" as const }
              : l,
        ),
      },
    };
    const rows = read(blueReturnToCsv(r, { blankUnused: true }));
    expect(rows.find((row) => row[1] === "8")?.[3]).toBe("");
    expect(rows.find((row) => row[1] === "2")?.[3]).toBe("0");
  });

  it("欄名のカンマ・引用符は引用される", () => {
    const base = buildBlueReturn({
      period: yearPeriod(),
      accounts: [],
      lines: [],
      deductionAnswers: answers,
      taxParameters: TAX_PARAMETERS,
    });
    const r = {
      ...base,
      page1: {
        lines: base.page1.lines.map((l) => (l.no === 25 ? { ...l, label: 'A,"B"' } : l)),
      },
    };
    const rows = read(blueReturnToCsv(r, { blankUnused: false }));
    expect(rows.find((row) => row[1] === "25")?.[2]).toBe('A,"B"');
  });
});

/** 2〜4ページに値を入れた決算書（手で組む） */
function fullReturn(): BlueReturn {
  const base = buildBlueReturn({
    period: yearPeriod(),
    accounts: [],
    lines: [],
    deductionAnswers: answers,
    taxParameters: TAX_PARAMETERS,
  });
  return {
    ...base,
    page2: {
      monthly: {
        months: Array.from({ length: 12 }, (_, i) => ({
          month: i + 1,
          sales: (i + 1) * 1000,
          otherIncome: i,
          total: (i + 1) * 1000 + i,
        })),
        total: { sales: 78000, otherIncome: 66, total: 78066 },
      },
      rentDetails: [
        { payee: "山田, 太郎", property: "事務所", annualRent: 1200000, deductibleAmount: 600000 },
        { payee: "鈴木不動産", property: "駐車場", annualRent: 240000, deductibleAmount: 240000 },
      ],
      deduction: { cap: 650000, tier: "max", unmet: [], amount: 650000 },
    },
    page3: {
      salesPartners: {
        rows: [
          { partnerId: "a", name: "株式会社A", amount: 500000 },
          { partnerId: "b", name: "B商店", amount: 300000 },
        ],
        others: 70000,
        total: 870000,
        withoutPartner: null,
      },
      depreciation: [
        {
          assetId: "x",
          name: "ノートPC",
          quantity: "1",
          acquiredOn: "2025-03-01",
          cost: 200000,
          method: "small_asset_28_2",
          usefulLifeYears: null,
          base: 200000,
          ordinary: 200000,
          total: 200000,
          businessRatio: 5000,
          deductible: 100000,
          closingBookValue: 0,
          note: null,
        },
        {
          assetId: "y",
          name: "デスク",
          quantity: null,
          acquiredOn: "2025-05-01",
          cost: 90000,
          method: "small_asset_28_2",
          usefulLifeYears: null,
          base: 90000,
          ordinary: 90000,
          total: 90000,
          businessRatio: 10000,
          deductible: 90000,
          closingBookValue: 0,
          note: "メモ",
        },
      ],
      specialCircumstances: '7月に事務所を移転した,\n"引越"あり',
    },
    page4: {
      opening: {
        assets: {
          rows: [
            { label: "現金", amount: 10000 },
            { label: "普通預金", amount: null },
          ],
          total: 10000,
        },
        liabilityEquity: { rows: [{ label: "元入金", amount: 10000 }], total: 10000 },
      },
      closing: {
        assets: { rows: [{ label: "現金", amount: 50000 }], total: 50000 },
        liabilityEquity: {
          rows: [
            { label: "未払金", amount: 20000 },
            { label: "元入金", amount: 30000 },
          ],
          total: 50000,
        },
      },
      carryForwardCheck: "matched",
      openingDifferenceNote: "差の説明",
    },
  };
}

/** 指定ページの行を { 欄番号 → [欄名, 金額] } の並びで返す */
const pageRows = (csv: string, page: number) =>
  read(csv)
    .slice(1)
    .filter((row) => row[0] === String(page))
    .map((row) => [row[1], row[2], row[3]]);

describe("blueReturnToCsv の2〜4ページ（FR-003, US5 シナリオ5）", () => {
  const csv = blueReturnToCsv(fullReturn(), { blankUnused: false });

  it("2ページ: 月別の売上・雑収入・月計と合計", () => {
    const rows = pageRows(csv, 2);
    for (let m = 1; m <= 12; m++) {
      expect(rows).toContainEqual([`${m}月`, "売上", String(m * 1000)]);
      expect(rows).toContainEqual([`${m}月`, "雑収入", String(m - 1)]);
      expect(rows).toContainEqual([`${m}月`, "月計", String(m * 1000 + m - 1)]);
    }
    expect(rows).toContainEqual(["計", "売上", "78000"]);
    expect(rows).toContainEqual(["計", "雑収入", "66"]);
    expect(rows).toContainEqual(["計", "計", "78066"]);
  });

  it("2ページ: 地代家賃の内訳は金額ごとに行を分け、控除の計算を出す", () => {
    const rows = pageRows(csv, 2);
    expect(rows).toContainEqual(["内訳1", "山田, 太郎（事務所）: 賃借料", "1200000"]);
    expect(rows).toContainEqual(["内訳1", "山田, 太郎（事務所）: 必要経費算入額", "600000"]);
    expect(rows).toContainEqual(["内訳2", "鈴木不動産（駐車場）: 賃借料", "240000"]);
    expect(rows).toContainEqual(["内訳2", "鈴木不動産（駐車場）: 必要経費算入額", "240000"]);
    expect(rows).toContainEqual(["控除上限", "青色申告特別控除の上限", "650000"]);
    expect(rows).toContainEqual(["控除額", "青色申告特別控除額", "650000"]);
  });

  it("2ページ: 控除の回答がなければ控除の金額は空", () => {
    const r = fullReturn();
    const rows = pageRows(
      blueReturnToCsv({ ...r, page2: { ...r.page2, deduction: null } }, { blankUnused: false }),
      2,
    );
    expect(rows).toContainEqual(["控除上限", "青色申告特別控除の上限", ""]);
    expect(rows).toContainEqual(["控除額", "青色申告特別控除額", ""]);
  });

  it("3ページ: 売上先、上記以外、計", () => {
    const rows = pageRows(csv, 3);
    expect(rows).toContainEqual(["売上先1", "株式会社A", "500000"]);
    expect(rows).toContainEqual(["売上先2", "B商店", "300000"]);
    expect(rows).toContainEqual(["上記以外", "上記以外の売上先の計", "70000"]);
    expect(rows).toContainEqual(["計", "売上先の合計", "870000"]);
  });

  it("3ページ: 減価償却は金額ごとに行を分ける", () => {
    const rows = pageRows(csv, 3);
    expect(rows).toContainEqual(["資産1", "ノートPC: 取得価額", "200000"]);
    expect(rows).toContainEqual(["資産1", "ノートPC: 償却の基礎になる金額", "200000"]);
    expect(rows).toContainEqual(["資産1", "ノートPC: 本年分の普通償却費", "200000"]);
    expect(rows).toContainEqual(["資産1", "ノートPC: 本年分の償却費合計", "200000"]);
    expect(rows).toContainEqual(["資産1", "ノートPC: 事業専用割合（%）", "50"]);
    expect(rows).toContainEqual(["資産1", "ノートPC: 必要経費算入額", "100000"]);
    expect(rows).toContainEqual(["資産1", "ノートPC: 未償却残高", "0"]);
    expect(rows).toContainEqual(["資産2", "デスク: 必要経費算入額", "90000"]);
    expect(rows).toContainEqual(["資産2", "デスク: 事業専用割合（%）", "100"]);
  });

  it("3ページ: 特殊事情の行が金額でない唯一の行（本文は引用されて読み戻せる）", () => {
    const rows = read(csv).slice(1);
    const notNumeric = rows.filter((row) => !/^(-?\d+(\.\d+)?)?$/.test(row[3] ?? ""));
    expect(notNumeric).toEqual([
      ["3", "特殊事情", "本年中における特殊事情", '7月に事務所を移転した,\n"引越"あり'],
    ]);
  });

  it("3ページ: 特殊事情がなければ金額の列は空", () => {
    const r = fullReturn();
    const rows = pageRows(
      blueReturnToCsv(
        { ...r, page3: { ...r.page3, specialCircumstances: null } },
        { blankUnused: false },
      ),
      3,
    );
    expect(rows).toContainEqual(["特殊事情", "本年中における特殊事情", ""]);
  });

  it("4ページ: 期首と期末を区別し、null は空", () => {
    const rows = pageRows(csv, 4);
    expect(rows).toContainEqual(["期首:現金", "現金", "10000"]);
    expect(rows).toContainEqual(["期首:普通預金", "普通預金", ""]);
    expect(rows).toContainEqual(["期首:元入金", "元入金", "10000"]);
    expect(rows).toContainEqual(["期首:資産の部合計", "資産の部合計", "10000"]);
    expect(rows).toContainEqual(["期首:負債・資本の部合計", "負債・資本の部合計", "10000"]);
    expect(rows).toContainEqual(["期末:現金", "現金", "50000"]);
    expect(rows).toContainEqual(["期末:未払金", "未払金", "20000"]);
    expect(rows).toContainEqual(["期末:元入金", "元入金", "30000"]);
    expect(rows).toContainEqual(["期末:資産の部合計", "資産の部合計", "50000"]);
    expect(rows).toContainEqual(["期末:負債・資本の部合計", "負債・資本の部合計", "50000"]);
  });

  it("blankUnused は2〜4ページの行を変えない", () => {
    const blank = blueReturnToCsv(fullReturn(), { blankUnused: true });
    for (const page of [2, 3, 4]) expect(pageRows(blank, page)).toEqual(pageRows(csv, page));
  });

  it("実際に導出した決算書でも、月別12か月と4ページの行数が値と一致する", () => {
    fc.assert(
      fc.property(yearLedgerArb, (ledger) => {
        const r = buildBlueReturn({
          period: ledger.period,
          accounts: ledger.accounts,
          lines: ledger.lines,
          deductionAnswers: answers,
          taxParameters: TAX_PARAMETERS,
        });
        const out = blueReturnToCsv(r, { blankUnused: false });
        const p2 = pageRows(out, 2);
        for (const m of r.page2.monthly.months) {
          expect(p2).toContainEqual([`${m.month}月`, "売上", String(m.sales)]);
        }
        const p4 = pageRows(out, 4);
        const count = (b: BlueReturn["page4"]["opening"]) =>
          b.assets.rows.length + b.liabilityEquity.rows.length + 2;
        expect(p4).toHaveLength(count(r.page4.opening) + count(r.page4.closing));
        const p3 = pageRows(out, 3);
        expect(p3).toContainEqual(["計", "売上先の合計", String(r.page3.salesPartners.total)]);
      }),
    );
  });
});

function yearPeriod() {
  return {
    id: "p",
    fiscalYear: 2025,
    startDate: "2025-01-01",
    endDate: "2025-12-31",
    status: "open" as const,
    closedAt: null,
  };
}
