import { describe, expect, it } from "vitest";
import { type BuildBlueReturnInput, buildBlueReturn } from "../../src/blue-return/build.ts";
import { TAX_PARAMETERS } from "../../src/seed/tax-parameters.ts";
import type { FixedAsset, PostedLine } from "../../src/types.ts";
import { makeFiscalPeriod } from "../arbitraries.ts";
import { accountIdOf, INDIVIDUAL_ACCOUNT_LIST } from "../blue-return-arbitraries.ts";

const EQUIPMENT = accountIdOf("1060");
const DEPRECIATION = accountIdOf("5180");
const DRAWINGS = accountIdOf("3090");
const CASH = accountIdOf("1010");
const AT = "2026-01-10T00:00:00.000Z";

let seq = 0;
const entry = (debit: string, credit: string, amount: number): PostedLine[] => {
  seq += 1;
  const base = {
    journalId: `j-${seq}`,
    journalNo: seq,
    date: "2025-12-31",
    memo: null,
    status: "active" as const,
    accountName: "",
    subAccountName: null,
    amount,
    taxCategory: "OUT_OF_SCOPE" as const,
    taxAmount: 0,
    partnerId: null,
    partnerName: null,
    description: null,
    subAccountId: null,
  };
  return [
    { ...base, lineNo: 1, side: "debit", accountId: debit },
    { ...base, lineNo: 2, side: "credit", accountId: credit },
  ];
};

const asset = (over: Partial<FixedAsset> = {}): FixedAsset => ({
  id: "asset-1",
  name: "ノートパソコン",
  quantity: "1台",
  acquiredOn: "2025-06-15",
  acquisitionCost: 200_000,
  method: "small_asset_28_2",
  usefulLifeYears: null,
  businessRatio: 10000,
  assetAccountId: EQUIPMENT,
  linkedJournalId: null,
  note: "業務用",
  disposedOn: null,
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

const build = (over: Partial<BuildBlueReturnInput> = {}) =>
  buildBlueReturn({
    period: makeFiscalPeriod(2025),
    accounts: INDIVIDUAL_ACCOUNT_LIST,
    lines: [],
    deductionAnswers: null,
    taxParameters: TAX_PARAMETERS,
    ...over,
  });

const line = (r: ReturnType<typeof build>, no: number) =>
  r.page1.lines.find((l) => l.no === no)?.amount;
const mismatch = (r: ReturnType<typeof build>) =>
  r.warnings.filter((w) => w.code === "DEPRECIATION_MISMATCH");

describe("buildBlueReturn の3ページ 減価償却費の計算（FR-023）", () => {
  it("取得した年の資産を、3ページの列（イ〜ヌ）の値で載せる", () => {
    const r = build({
      lines: entry(DEPRECIATION, EQUIPMENT, 200_000),
      fixedAssets: [asset()],
    });
    expect(r.page3.depreciation).toEqual([
      {
        assetId: "asset-1",
        name: "ノートパソコン",
        quantity: "1台",
        acquiredOn: "2025-06-15",
        cost: 200_000,
        method: "small_asset_28_2",
        usefulLifeYears: null,
        base: 200_000,
        ordinary: 200_000,
        total: 200_000,
        businessRatio: 10000,
        deductible: 200_000,
        closingBookValue: 0,
        note: "業務用",
      },
    ]);
    expect(line(r, 18)).toBe(200_000);
    expect(mismatch(r)).toEqual([]);
  });

  it("資産がなければ表は空で、欄18 も 0 なら警告しない", () => {
    const r = build();
    expect(r.page3.depreciation).toEqual([]);
    expect(mismatch(r)).toEqual([]);
  });

  it("取得した年以外の資産（未償却残高もない）と、年末までに除却した資産は載せない", () => {
    const r = build({
      fixedAssets: [
        asset({ id: "old", acquiredOn: "2024-03-01" }),
        asset({ id: "future", acquiredOn: "2026-01-01" }),
        asset({ id: "gone", disposedOn: "2025-12-31" }),
        asset({ id: "later", disposedOn: "2026-01-01" }),
      ],
      lines: entry(DEPRECIATION, EQUIPMENT, 200_000),
    });
    expect(r.page3.depreciation.map((d) => d.assetId)).toEqual(["later"]);
  });

  it("取得日の順に並べる", () => {
    const r = build({
      fixedAssets: [
        asset({ id: "b", acquiredOn: "2025-09-01", acquisitionCost: 100_000 }),
        asset({ id: "a", acquiredOn: "2025-02-01", acquisitionCost: 100_000 }),
      ],
      lines: entry(DEPRECIATION, EQUIPMENT, 200_000),
    });
    expect(r.page3.depreciation.map((d) => d.assetId)).toEqual(["a", "b"]);
  });

  it("必要経費算入額の合計が欄18 と違えば DEPRECIATION_MISMATCH（合計・欄18・差）", () => {
    const r = build({ fixedAssets: [asset()] }); // 仕訳がまだない
    const [w, ...rest] = mismatch(r);
    expect(rest).toEqual([]);
    expect(w?.details).toEqual({
      depreciationTotal: 200_000,
      line18: 0,
      difference: 200_000,
    });
    // 金額は 001 の formatSignedAmount と同じ書式（桁区切り）
    expect(w?.message).toBe(
      "3ページの必要経費算入額の合計（200,000 円）が欄18 の減価償却費（0 円）と一致しません",
    );
  });

  it("資産がなくても、欄18 が 0 でなければ警告する", () => {
    const r = build({ lines: entry(DEPRECIATION, EQUIPMENT, 50_000) });
    expect(mismatch(r)).toHaveLength(1);
  });

  it("割合 50% は、家事分の振替の後の欄18 が必要経費算入額と一致する", () => {
    const a = asset({ businessRatio: 5000 });
    const before = build({
      lines: entry(DEPRECIATION, EQUIPMENT, 200_000),
      fixedAssets: [a],
    });
    expect(before.page3.depreciation[0]).toMatchObject({ total: 200_000, deductible: 100_000 });
    expect(mismatch(before)).toHaveLength(1);
    const after = build({
      lines: [
        ...entry(DEPRECIATION, EQUIPMENT, 200_000),
        ...entry(DRAWINGS, DEPRECIATION, 100_000),
      ],
      fixedAssets: [a],
    });
    expect(line(after, 18)).toBe(100_000);
    expect(mismatch(after)).toEqual([]);
  });

  it("結びつけた資産も表に載り、結びつけた仕訳の科目が減価償却費でなければ警告で知らせる（シナリオ5）", () => {
    const linked = asset({ linkedJournalId: "j-linked" });
    const asExpense = build({
      lines: entry(DEPRECIATION, CASH, 200_000),
      fixedAssets: [linked],
    });
    expect(asExpense.page3.depreciation).toHaveLength(1);
    expect(mismatch(asExpense)).toEqual([]);
    const asSupplies = build({
      lines: entry(accountIdOf("5170"), CASH, 200_000),
      fixedAssets: [linked],
    });
    expect(asSupplies.page3.depreciation).toHaveLength(1);
    expect(mismatch(asSupplies)).toHaveLength(1);
  });
});
