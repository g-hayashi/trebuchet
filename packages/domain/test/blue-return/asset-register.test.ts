import { describe, expect, it } from "vitest";
import { checkAssetRegister } from "../../src/blue-return/asset-register.ts";
import { STRAIGHT_LINE_RATES } from "../../src/seed/depreciation-rates.ts";
import { TAX_PARAMETERS } from "../../src/seed/tax-parameters.ts";
import type { FixedAsset } from "../../src/types.ts";
import { accountIdOf, INDIVIDUAL_ACCOUNT_LIST } from "../blue-return-arbitraries.ts";

const AT = "2026-01-10T00:00:00.000Z";
const params = { rates: STRAIGHT_LINE_RATES, taxParameters: TAX_PARAMETERS };

/** 定額法の資産（既定: 2025-07-10 に取得・供用、500,000 円、耐用年数 4 年 = 率 250。1060 工具器具備品） */
const asset = (over: Partial<FixedAsset> = {}): FixedAsset => ({
  id: "asset-1",
  name: "機材A",
  quantity: null,
  acquiredOn: "2025-07-10",
  acquisitionCost: 500_000,
  method: "straight_line",
  usefulLifeYears: 4,
  inServiceOn: null,
  priorAccumulated: 0,
  priorThroughYear: null,
  businessRatio: 10000,
  assetAccountId: accountIdOf("1060"),
  linkedJournalId: null,
  note: null,
  disposedOn: null,
  disposalKind: null,
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

const small = (over: Partial<FixedAsset> = {}): FixedAsset =>
  asset({
    id: "small-1",
    name: "少額の機材",
    acquiredOn: "2025-03-01",
    acquisitionCost: 240_000,
    method: "small_asset_28_2",
    usefulLifeYears: null,
    ...over,
  });

type OpeningRow = {
  accountId: string;
  subAccountId: string | null;
  side: "debit" | "credit";
  amount: number;
};

/** 借方の期首残高 */
const debit = (code: string, amount: number, subAccountId: string | null = null): OpeningRow => ({
  accountId: accountIdOf(code),
  subAccountId,
  side: "debit",
  amount,
});

/** 2025 年の償却（⌈500,000 × 250 × 6 / 12,000⌉ = 62,500）の後の、2026 年の期首の未償却残高 */
const OPENING_2026 = 437_500;

const check = (
  fixedAssets: readonly FixedAsset[],
  opening: OpeningRow[],
  over: Partial<Parameters<typeof checkAssetRegister>[0]> = {},
) =>
  checkAssetRegister({
    fiscalYear: 2026,
    accounts: INDIVIDUAL_ACCOUNT_LIST,
    opening,
    fixedAssets,
    params,
    ...over,
  });

describe("checkAssetRegister（FR-020、R10、INV-59）", () => {
  it("帳簿の期首と台帳の期首が一致すれば警告なし", () => {
    expect(check([asset()], [debit("1060", OPENING_2026)])).toEqual([]);
  });

  it("資産がなければ照合しない", () => {
    expect(check([], [debit("1060", 100_000)])).toEqual([]);
  });

  it("差があれば勘定ごとに ASSET_REGISTER_MISMATCH（差 = 帳簿 − 台帳）", () => {
    const w = check([asset()], [debit("1060", OPENING_2026 + 2_500)]);
    expect(w).toHaveLength(1);
    expect(w[0]?.code).toBe("ASSET_REGISTER_MISMATCH");
    expect(w[0]?.details).toEqual({
      accountId: accountIdOf("1060"),
      accountName: "工具器具備品",
      bookOpening: OPENING_2026 + 2_500,
      registerOpening: OPENING_2026,
      difference: 2_500,
    });
  });

  it("帳簿の期首がない勘定は 0 として比べる（台帳が正なら不足の差）", () => {
    const w = check([asset()], []);
    expect(w).toHaveLength(1);
    expect(w[0]?.details).toMatchObject({
      bookOpening: 0,
      registerOpening: OPENING_2026,
      difference: -OPENING_2026,
    });
  });

  it("補助科目は合計して比べる", () => {
    expect(
      check(
        [asset()],
        [debit("1060", 400_000, "sub-a"), debit("1060", OPENING_2026 - 400_000, "sub-b")],
      ),
    ).toEqual([]);
  });

  it("貸方の期首残高は負として数える", () => {
    const w = check(
      [asset()],
      [debit("1060", OPENING_2026 + 10_000), { ...debit("1060", 10_000), side: "credit" }],
    );
    expect(w).toEqual([]);
  });

  it("複数の資産は同じ勘定で合計し、勘定が違えば別々に警告する", () => {
    const second = asset({
      id: "asset-2",
      acquiredOn: "2025-01-05",
      acquisitionCost: 1_000_000,
      usefulLifeYears: 5, // 率 200。2025 年は 12 か月 = 200,000
      assetAccountId: accountIdOf("1070"),
    });
    expect(check([asset(), second], [debit("1060", OPENING_2026), debit("1070", 800_000)])).toEqual(
      [],
    );
    const w = check(
      [asset(), second],
      [debit("1060", OPENING_2026 + 1), debit("1070", 800_000 - 1)],
    );
    expect(w.map((x) => x.details?.accountId)).toEqual([accountIdOf("1060"), accountIdOf("1070")]);
  });

  it("その年度に取得した資産は期首に含めない", () => {
    const acquiredThisYear = asset({
      id: "asset-2",
      acquiredOn: "2026-02-10",
      acquisitionCost: 300_000,
    });
    expect(check([asset(), acquiredThisYear], [debit("1060", OPENING_2026)])).toEqual([]);
    // その年度に取得した資産だけなら、その勘定の期首の台帳は 0
    const w = check([acquiredThisYear], [debit("1060", 50_000)]);
    expect(w[0]?.details).toMatchObject({ registerOpening: 0, difference: 50_000 });
    expect(check([acquiredThisYear], [])).toEqual([]);
  });

  it("その年度より後に取得した資産だけの勘定は対象にしない", () => {
    expect(check([asset({ acquiredOn: "2027-02-10" })], [debit("1060", 50_000)])).toEqual([]);
  });

  it("定額法の資産を前の年度に除却していれば、その資産の分は 0（除却の年度の期首は残高がある）", () => {
    const disposedBefore = asset({ disposedOn: "2025-12-20", disposalKind: "scrap" });
    expect(check([disposedBefore], [])).toEqual([]);
    const w = check([disposedBefore], [debit("1060", 1)]);
    expect(w[0]?.details).toMatchObject({ registerOpening: 0, difference: 1 });
    // 除却の年度（2026）の期首は、除却前なので残高がある
    const disposedInYear = asset({ disposedOn: "2026-03-15", disposalKind: "sale" });
    expect(check([disposedInYear], [debit("1060", OPENING_2026)])).toEqual([]);
  });

  it("前年までの累計を入れた資産は、累計の翌年から積み上げた期首で比べる", () => {
    // 2024-01-15 取得、2025 年分までの累計 120,000。2026 年の期首 = 500,000 − 120,000
    const withPrior = asset({
      acquiredOn: "2024-01-15",
      priorAccumulated: 120_000,
      priorThroughYear: 2025,
    });
    expect(check([withPrior], [debit("1060", 380_000)])).toEqual([]);
  });

  it("累計の年が年度以後の資産がある勘定は、台帳がその年度を計算しないので照合しない", () => {
    const throughThisYear = asset({
      acquiredOn: "2024-01-15",
      priorAccumulated: 200_000,
      priorThroughYear: 2026,
    });
    expect(check([throughThisYear], [debit("1060", 1)])).toEqual([]);
    // 同じ勘定の別の資産が一致していなくても、その勘定ごと飛ばす
    expect(check([asset({ id: "asset-2" }), throughThisYear], [debit("1060", 1)])).toEqual([]);
    // 別の勘定は照合する
    const other = asset({ id: "asset-3", assetAccountId: accountIdOf("1070") });
    const w = check([throughThisYear, other], [debit("1060", 1), debit("1070", 1)]);
    expect(w.map((x) => x.details?.accountId)).toEqual([accountIdOf("1070")]);
  });

  it("少額の特例の資産だけが使う勘定は対象にしない", () => {
    expect(check([small()], [debit("1060", 240_000)])).toEqual([]);
  });

  it("定額法の資産と同じ勘定にある少額の特例の資産は、台帳の期首に 0 を足す（帳簿に残高があれば差になる）", () => {
    expect(check([asset(), small()], [debit("1060", OPENING_2026)])).toEqual([]);
    const w = check([asset(), small()], [debit("1060", OPENING_2026 + 240_000)]);
    expect(w[0]?.details).toMatchObject({ difference: 240_000 });
  });

  it("償却率がなく台帳の期首を計算できない資産がある勘定は照合しない", () => {
    expect(check([asset()], [debit("1060", 1)], { params: { ...params, rates: [] } })).toEqual([]);
  });

  it("警告の message に勘定名と差を入れる", () => {
    const w = check([asset()], [debit("1060", OPENING_2026 + 2_500)]);
    expect(w[0]?.message).toContain("工具器具備品");
    expect(w[0]?.message).toContain("2,500");
  });
});
