import { describe, expect, it } from "vitest";
import { type BuildBlueReturnInput, buildBlueReturn } from "../../src/blue-return/build.ts";
import { STRAIGHT_LINE_RATES } from "../../src/seed/depreciation-rates.ts";
import { TAX_PARAMETERS } from "../../src/seed/tax-parameters.ts";
import type {
  DeferredAmortization,
  DeferredAsset,
  FixedAsset,
  PostedLine,
} from "../../src/types.ts";
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
  inServiceOn: null,
  priorAccumulated: 0,
  priorThroughYear: null,
  businessRatio: 10000,
  assetAccountId: EQUIPMENT,
  linkedJournalId: null,
  note: "業務用",
  disposedOn: null,
  disposalKind: null,
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
    straightLineRates: STRAIGHT_LINE_RATES,
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
        source: "fixed_asset",
        method: "small_asset_28_2",
        usefulLifeYears: null,
        ratePermille: null,
        months: null,
        disposedOn: null,
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

describe("buildBlueReturn の定額法（009 FR-018〜020、R10・R11）", () => {
  const straight = (over: Partial<FixedAsset> = {}) =>
    asset({
      method: "straight_line",
      usefulLifeYears: 5,
      acquiredOn: "2025-04-10",
      acquisitionCost: 1_000_000,
      note: null,
      ...over,
    });
  const missing = (r: ReturnType<typeof build>) =>
    r.warnings.filter((w) => w.code === "DEPRECIATION_PARAMETER_MISSING");
  const registerMismatch = (r: ReturnType<typeof build>) =>
    r.warnings.filter((w) => w.code === "ASSET_REGISTER_MISMATCH");

  it("定額法の資産を、償却率・本年中の償却期間つきで 3 ページに載せ、欄18 と一致する", () => {
    const r = build({
      lines: entry(DEPRECIATION, EQUIPMENT, 150_000),
      fixedAssets: [straight()],
    });
    // 耐用年数 5 年 = 償却率 200、4 月〜12 月の 9 か月: ⌈1,000,000 × 200 × 9 / 12,000⌉ = 150,000
    expect(r.page3.depreciation).toEqual([
      {
        assetId: "asset-1",
        name: "ノートパソコン",
        quantity: "1台",
        acquiredOn: "2025-04-10",
        cost: 1_000_000,
        source: "fixed_asset",
        method: "straight_line",
        usefulLifeYears: 5,
        ratePermille: 200,
        months: 9,
        disposedOn: null,
        base: 1_000_000,
        ordinary: 150_000,
        total: 150_000,
        businessRatio: 10000,
        deductible: 150_000,
        closingBookValue: 850_000,
        note: null,
      },
    ]);
    expect(line(r, 18)).toBe(150_000);
    expect(mismatch(r)).toEqual([]);
    expect(missing(r)).toEqual([]);
  });

  it("除却の年度の資産も載せ（除却の日・月数）、少額の特例の行と取得日の順に並ぶ", () => {
    const disposed = straight({
      id: "gone",
      acquiredOn: "2023-01-10",
      acquisitionCost: 600_000,
      usefulLifeYears: 3,
      disposedOn: "2025-06-20",
      disposalKind: "scrap",
    });
    const r = build({
      lines: entry(DEPRECIATION, EQUIPMENT, 300_000),
      fixedAssets: [asset({ id: "pc" }), disposed],
    });
    expect(r.page3.depreciation.map((d) => d.assetId)).toEqual(["gone", "pc"]);
    // 2023・2024 年は 12 か月 ⌈600,000 × 334 × 12 / 12,000⌉ = 200,400 ずつ。2025 年は 1〜6 月の 6 か月
    expect(r.page3.depreciation[0]).toMatchObject({
      source: "fixed_asset",
      method: "straight_line",
      ratePermille: 334,
      months: 6,
      disposedOn: "2025-06-20",
      ordinary: 100_200,
    });
  });

  it("除却損（5300）は欄18 に含めない。任意欄に載り、欄32・33 は損益計算書と一致する", () => {
    const r = build({
      lines: [...entry("0000000a-0000-7000-8000-000000005300", EQUIPMENT, 50_000)],
    });
    expect(line(r, 18)).toBe(0);
    expect(line(r, 32)).toBe(50_000);
    expect(r.page1.lines.find((l) => l.label === "固定資産除却損")?.amount).toBe(50_000);
    expect(mismatch(r)).toEqual([]);
    expect(r.warnings.map((w) => w.code)).not.toContain("PL_MISMATCH");
  });

  it("償却率がなく計算できない資産は行に載せず、DEPRECIATION_PARAMETER_MISSING を資産ごとに 1 件出す", () => {
    const r = build({
      lines: entry(DEPRECIATION, EQUIPMENT, 50_000),
      fixedAssets: [
        straight({ id: "no-rate", usefulLifeYears: 99 }),
        straight({ id: "ok", usefulLifeYears: 5 }),
      ],
    });
    expect(r.page3.depreciation.map((d) => d.assetId)).toEqual(["ok"]);
    const [w, ...rest] = missing(r);
    expect(rest).toEqual([]);
    expect(w?.details).toEqual({
      source: "fixed_asset",
      sourceId: "no-rate",
      key: "STRAIGHT_LINE_RATE",
      date: "2025-04-10",
    });
    expect(w?.message).toContain("ノートパソコン");
  });

  it("率の表が空なら、年度に関わる定額法の資産すべてで警告する。その年度に関わらない資産には出さない", () => {
    const r = build({
      straightLineRates: [],
      fixedAssets: [
        straight({ id: "a" }),
        straight({ id: "future", acquiredOn: "2026-01-01" }),
        straight({
          id: "gone",
          acquiredOn: "2023-01-10",
          disposedOn: "2024-05-01",
          disposalKind: "scrap",
        }),
        asset({ id: "small" }),
      ],
    });
    expect(r.page3.depreciation.map((d) => d.assetId)).toEqual(["small"]);
    expect(missing(r).map((w) => w.details?.sourceId)).toEqual(["a"]);
  });

  it("帳簿の期首と台帳の期首が違えば ASSET_REGISTER_MISMATCH（一致すれば出さない）", () => {
    // 2024-07-10 取得: 2024 年は 6 か月 ⌈500,000 × 250 × 6 / 12,000⌉ = 62,500、2025 年の期首の未償却残高 437,500
    const a = straight({
      id: "old",
      acquiredOn: "2024-07-10",
      acquisitionCost: 500_000,
      usefulLifeYears: 4,
    });
    const opening = (amount: number) => [
      { accountId: EQUIPMENT, subAccountId: null, side: "debit" as const, amount },
    ];
    expect(registerMismatch(build({ fixedAssets: [a], opening: opening(437_500) }))).toEqual([]);
    const [w, ...rest] = registerMismatch(build({ fixedAssets: [a], opening: opening(400_000) }));
    expect(rest).toEqual([]);
    expect(w?.details).toMatchObject({
      accountId: EQUIPMENT,
      bookOpening: 400_000,
      registerOpening: 437_500,
      difference: -37_500,
    });
  });
});

describe("buildBlueReturn の開業費（009 US3、FR-015、FR-019、R11）", () => {
  const DEFERRED = accountIdOf("1080");

  /** 開業費（2025-04-01 開業、総額 300,000 円、累計なし、1080 開業費） */
  const deferred = (over: Partial<DeferredAsset> = {}): DeferredAsset => ({
    id: "deferred-1",
    name: "開業費",
    totalAmount: 300_000,
    openedOn: "2025-04-01",
    priorAccumulated: 0,
    priorThroughYear: null,
    accountId: DEFERRED,
    note: "開業準備",
    createdAt: AT,
    updatedAt: AT,
    ...over,
  });
  const decided = (fiscalYear: number, amount: number): DeferredAmortization => ({
    deferredAssetId: "deferred-1",
    fiscalYear,
    amount,
    decidedAt: AT,
    updatedAt: AT,
  });
  const refOf = (fiscalYear: number, active: boolean) => ({
    journalId: `jr-${fiscalYear}`,
    kind: "deferred_amortization" as const,
    allocationId: null,
    assetId: null,
    deferredAssetId: "deferred-1",
    fiscalYear,
    active,
  });
  const line18 = (r: ReturnType<typeof build>) => r.page1.lines.find((l) => l.no === 18)?.amount;
  const missing = (r: ReturnType<typeof build>) =>
    r.warnings.filter((w) => w.code === "DEPRECIATION_PARAMETER_MISSING");
  const registerMismatch = (r: ReturnType<typeof build>) =>
    r.warnings.filter((w) => w.code === "ASSET_REGISTER_MISMATCH");

  it("決定の額で開業費の行を 3 ページに載せ（source は deferred_asset、method は deferred）、欄18 と一致する", () => {
    const r = build({
      deferredAssets: [deferred()],
      deferredAmortizations: [decided(2025, 45_000)],
      lines: entry(DEPRECIATION, DEFERRED, 45_000),
    });
    expect(r.page3.depreciation).toEqual([
      {
        assetId: "deferred-1",
        name: "開業費",
        quantity: null,
        acquiredOn: "2025-04-01",
        cost: 300_000,
        source: "deferred_asset",
        method: "deferred",
        usefulLifeYears: null,
        ratePermille: null,
        months: null,
        disposedOn: null,
        base: 300_000,
        ordinary: 45_000,
        total: 45_000,
        businessRatio: 10000,
        deductible: 45_000,
        closingBookValue: 255_000,
        note: "開業準備",
      },
    ]);
    expect(line18(r)).toBe(45_000);
    expect(mismatch(r)).toEqual([]);
  });

  it("資産の行の後に開業費の行を並べ、必要経費算入額の合計が欄18 と一致する", () => {
    const r = build({
      fixedAssets: [asset()],
      deferredAssets: [deferred()],
      deferredAmortizations: [decided(2025, 45_000)],
      lines: [...entry(DEPRECIATION, EQUIPMENT, 200_000), ...entry(DEPRECIATION, DEFERRED, 45_000)],
    });
    expect(r.page3.depreciation.map((d) => d.assetId)).toEqual(["asset-1", "deferred-1"]);
    expect(line18(r)).toBe(245_000);
    expect(mismatch(r)).toEqual([]);
  });

  it("仕訳を登録していなければ、行は載り、欄18 との不一致の警告が出る", () => {
    const r = build({
      deferredAssets: [deferred()],
      deferredAmortizations: [decided(2025, 45_000)],
    });
    expect(r.page3.depreciation).toHaveLength(1);
    expect(mismatch(r).map((w) => w.details)).toEqual([
      { depreciationTotal: 45_000, line18: 0, difference: 45_000 },
    ]);
  });

  it("決定がない・0 円・別の年度の決定の開業費は載せない", () => {
    for (const decisions of [[], [decided(2025, 0)], [decided(2026, 10_000)]]) {
      const r = build({ deferredAssets: [deferred()], deferredAmortizations: decisions });
      expect(r.page3.depreciation).toEqual([]);
      expect(mismatch(r)).toEqual([]);
    }
  });

  it("前の年度の有効な償却の仕訳を引いた残高で計算する（取り消した仕訳は引かない）", () => {
    const input = (active: boolean) => ({
      period: makeFiscalPeriod(2026),
      deferredAssets: [deferred()],
      deferredAmortizations: [decided(2025, 45_000), decided(2026, 20_000)],
      adjustmentRefsAll: [refOf(2025, active)],
    });
    expect(build(input(true)).page3.depreciation[0]?.closingBookValue).toBe(235_000);
    expect(build(input(false)).page3.depreciation[0]?.closingBookValue).toBe(280_000);
  });

  it("均等償却の月数の税制の値がなければ、行に載せず DEPRECIATION_PARAMETER_MISSING（source は deferred_asset）", () => {
    const r = build({
      taxParameters: TAX_PARAMETERS.filter((p) => p.key !== "OPENING_COST_AMORTIZATION_MONTHS"),
      deferredAssets: [deferred()],
      deferredAmortizations: [decided(2025, 45_000)],
    });
    expect(r.page3.depreciation).toEqual([]);
    expect(missing(r).map((w) => w.details)).toEqual([
      {
        source: "deferred_asset",
        sourceId: "deferred-1",
        key: "OPENING_COST_AMORTIZATION_MONTHS",
        date: "2025-04-01",
      },
    ]);
  });

  it("開業費の帳簿の期首と台帳の期首が違えば ASSET_REGISTER_MISMATCH", () => {
    // 2026 年: 台帳の期首 = 総額 300,000 − 2025 年の有効な償却 45,000 = 255,000
    const input = (amount: number) => ({
      period: makeFiscalPeriod(2026),
      deferredAssets: [deferred()],
      deferredAmortizations: [decided(2025, 45_000)],
      adjustmentRefsAll: [refOf(2025, true)],
      opening: [{ accountId: DEFERRED, subAccountId: null, side: "debit" as const, amount }],
    });
    expect(registerMismatch(build(input(255_000)))).toEqual([]);
    const [w, ...rest] = registerMismatch(build(input(250_000)));
    expect(rest).toEqual([]);
    expect(w?.details).toMatchObject({
      accountId: DEFERRED,
      bookOpening: 250_000,
      registerOpening: 255_000,
      difference: -5_000,
    });
  });
});
