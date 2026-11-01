import { describe, expect, it } from "vitest";
import {
  depreciate,
  type FixedAssetDraft,
  isDepreciationRow,
  proposeDepreciationAdjustment,
  validateFixedAsset,
} from "../../src/blue-return/depreciation.ts";
import { STRAIGHT_LINE_RATES } from "../../src/seed/depreciation-rates.ts";
import { TAX_PARAMETERS } from "../../src/seed/tax-parameters.ts";
import type { FixedAsset } from "../../src/types.ts";
import { accountIdOf, INDIVIDUAL_ACCOUNT_LIST } from "../blue-return-arbitraries.ts";

const EQUIPMENT = accountIdOf("1060");
const DEPRECIATION = accountIdOf("5180");
const DRAWINGS = accountIdOf("3090");
const AT = "2026-01-10T00:00:00.000Z";

const asset = (over: Partial<FixedAsset> = {}): FixedAsset => ({
  id: "asset-1",
  name: "ノートパソコン",
  quantity: null,
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
  note: null,
  disposedOn: null,
  disposalKind: null,
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

const draft = (over: Partial<FixedAssetDraft> = {}): FixedAssetDraft => ({
  name: "ノートパソコン",
  quantity: null,
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
  note: null,
  ...over,
});

const params = { rates: STRAIGHT_LINE_RATES, taxParameters: TAX_PARAMETERS };
const ctx = { accounts: INDIVIDUAL_ACCOUNT_LIST, ...params };

/** 定額法の資産（US1 シナリオ1: 2026-07-10 に取得・供用、500,000 円、耐用年数 4 年） */
const straight = (over: Partial<FixedAsset> = {}): FixedAsset =>
  asset({
    name: "機材A",
    acquiredOn: "2026-07-10",
    acquisitionCost: 500_000,
    method: "straight_line",
    usefulLifeYears: 4,
    ...over,
  });
const straightDraft = (over: Partial<FixedAssetDraft> = {}): FixedAssetDraft =>
  draft({
    name: "機材A",
    acquiredOn: "2026-07-10",
    acquisitionCost: 500_000,
    method: "straight_line",
    usefulLifeYears: 4,
    ...over,
  });
const depOf = (a: FixedAsset, year: number) => {
  const r = depreciate(a, year, params);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};
const validate = (d: FixedAssetDraft, same: readonly FixedAsset[] = []) =>
  validateFixedAsset(d, same, ctx);
const errorOf = (r: ReturnType<typeof validate>) => {
  if (r.ok) throw new Error("エラーを期待しました");
  return r.error;
};

describe("validateFixedAsset（FR-018〜020、R7）", () => {
  it("取得価額 200,000 円・割合 100% は登録できる（シナリオ1）", () => {
    const r = validate(draft());
    expect(r.ok).toBe(true);
  });

  it("名前・備考の前後の空白を除き、空の数量・備考は null にする", () => {
    const r = validate(draft({ name: "  ノートPC  ", quantity: " ", note: "" }));
    expect(r.ok && r.value).toMatchObject({ name: "ノートPC", quantity: null, note: null });
  });

  it("資産の勘定の区分が資産でなければ ASSET_ACCOUNT_INVALID", () => {
    const e = errorOf(validate(draft({ assetAccountId: DEPRECIATION })));
    expect(e.code).toBe("ASSET_ACCOUNT_INVALID");
    expect(errorOf(validate(draft({ assetAccountId: "no-such" }))).code).toBe(
      "ASSET_ACCOUNT_INVALID",
    );
  });

  it("少額の特例以外の方法は DEPRECIATION_METHOD_UNSUPPORTED（シナリオ6）", () => {
    const bad = { ...draft(), method: "declining_balance" } as unknown as FixedAssetDraft;
    expect(errorOf(validate(bad)).code).toBe("DEPRECIATION_METHOD_UNSUPPORTED");
  });

  it("名前が空、取得価額が正の整数でない、割合が範囲外、日付の形が違えば VALIDATION", () => {
    expect(errorOf(validate(draft({ name: " " }))).code).toBe("VALIDATION");
    expect(errorOf(validate(draft({ acquisitionCost: 0 }))).code).toBe("VALIDATION");
    expect(errorOf(validate(draft({ acquisitionCost: 1.5 }))).code).toBe("VALIDATION");
    expect(errorOf(validate(draft({ businessRatio: 10001 }))).code).toBe("VALIDATION");
    expect(errorOf(validate(draft({ businessRatio: -1 }))).code).toBe("VALIDATION");
    expect(errorOf(validate(draft({ acquiredOn: "2025/06/15" }))).code).toBe("VALIDATION");
  });

  describe("基準額（取得の日に適用される値。シナリオ2）", () => {
    it("2026-03-31 取得の 350,000 円は拒否し、基準額と適用開始日を示す", () => {
      const e = errorOf(validate(draft({ acquiredOn: "2026-03-31", acquisitionCost: 350_000 })));
      expect(e.code).toBe("SMALL_ASSET_OVER_THRESHOLD");
      expect(e.details).toMatchObject({ threshold: 300_000, effectiveFrom: "2006-04-01" });
    });

    it("2026-04-01 取得の 350,000 円は登録できる（基準額が 400,000 円に変わる）", () => {
      expect(validate(draft({ acquiredOn: "2026-04-01", acquisitionCost: 350_000 })).ok).toBe(true);
    });

    it("基準額ちょうどは拒否し、1 円少なければ登録できる", () => {
      expect(
        errorOf(validate(draft({ acquiredOn: "2025-06-15", acquisitionCost: 300_000 }))).code,
      ).toBe("SMALL_ASSET_OVER_THRESHOLD");
      expect(validate(draft({ acquiredOn: "2025-06-15", acquisitionCost: 299_999 })).ok).toBe(true);
      expect(
        errorOf(validate(draft({ acquiredOn: "2026-04-01", acquisitionCost: 400_000 }))).code,
      ).toBe("SMALL_ASSET_OVER_THRESHOLD");
    });

    it("適用期間の外（2029-04-01 以後、2006-03-31 以前）は SMALL_ASSET_NOT_APPLICABLE", () => {
      const after = errorOf(
        validate(draft({ acquiredOn: "2029-04-01", acquisitionCost: 100_000 })),
      );
      expect(after.code).toBe("SMALL_ASSET_NOT_APPLICABLE");
      expect(after.details).toMatchObject({ appliesFrom: "2006-04-01", appliesTo: "2029-03-31" });
      expect(
        errorOf(validate(draft({ acquiredOn: "2006-03-31", acquisitionCost: 100_000 }))).code,
      ).toBe("SMALL_ASSET_NOT_APPLICABLE");
      expect(validate(draft({ acquiredOn: "2029-03-31", acquisitionCost: 100_000 })).ok).toBe(true);
    });
  });

  describe("年間の上限（同じ年の特例の資産の合計。シナリオ3）", () => {
    const others = [
      asset({ id: "a-1", acquisitionCost: 299_000 }),
      asset({ id: "a-2", acquisitionCost: 299_000, acquiredOn: "2025-01-01" }),
    ];
    // 2025 年の既存の合計 598,000 円。上限 3,000,000 円
    const big = [...Array(9).keys()].map((i) =>
      asset({ id: `big-${i}`, acquisitionCost: 299_000, acquiredOn: "2025-02-01" }),
    ); // 2,691,000 円

    it("合計が上限ちょうどなら登録できる", () => {
      // 2,691,000 + 299,000 = 2,990,000 ≤ 3,000,000。さらに 10,000 円で 3,000,000 ちょうど
      expect(validate(draft({ acquisitionCost: 299_000 }), big).ok).toBe(true);
      const exact = [...big, asset({ id: "x", acquisitionCost: 10_000, acquiredOn: "2025-03-01" })];
      expect(validate(draft({ acquisitionCost: 299_000 }), exact).ok).toBe(true);
      const over = [...big, asset({ id: "y", acquisitionCost: 11_000, acquiredOn: "2025-03-01" })];
      const e = errorOf(validate(draft({ acquisitionCost: 299_000 }), over));
      expect(e.code).toBe("SMALL_ASSET_ANNUAL_LIMIT_EXCEEDED");
      expect(e.details).toMatchObject({ limit: 3_000_000, total: 3_001_000 });
    });

    it("details.total は編集中の資産を含めた合計", () => {
      const e = errorOf(validate(draft({ acquisitionCost: 299_000 }), [...big, ...others]));
      expect(e.code).toBe("SMALL_ASSET_ANNUAL_LIMIT_EXCEEDED");
      expect(e.details).toMatchObject({ total: 2_691_000 + 598_000 + 299_000 });
    });

    it("編集中の資産自身（同じ id）は足さない", () => {
      const self = asset({ id: "me", acquisitionCost: 299_000, acquiredOn: "2025-04-01" });
      // self を除くと 2,691,000 + 299,000 = 2,990,000 で上限以内
      expect(validate(draft({ id: "me", acquisitionCost: 299_000 }), [...big, self]).ok).toBe(true);
    });

    it("別の年の資産は足さない", () => {
      const lastYear = asset({ id: "l", acquisitionCost: 299_000, acquiredOn: "2024-12-31" });
      const nextYear = asset({ id: "n", acquisitionCost: 299_000, acquiredOn: "2026-01-01" });
      expect(validate(draft({ acquisitionCost: 299_000 }), [...big, lastYear, nextYear]).ok).toBe(
        true,
      );
    });

    it("取得して同じ年に除却した資産も合計に含む（特例を使ったため）", () => {
      const disposed = asset({
        id: "d",
        acquisitionCost: 11_000,
        acquiredOn: "2025-03-01",
        disposedOn: "2025-09-01",
      });
      // 2,691,000 + 11,000 + 299,000 = 3,001,000 > 3,000,000
      const e = errorOf(validate(draft({ acquisitionCost: 299_000 }), [...big, disposed]));
      expect(e.code).toBe("SMALL_ASSET_ANNUAL_LIMIT_EXCEEDED");
      expect(e.details).toMatchObject({ total: 3_001_000 });
      // 翌年に除却した資産も同じ
      const later = asset({ ...disposed, disposedOn: "2026-02-01" });
      expect(validate(draft({ acquisitionCost: 299_000 }), [...big, later]).ok).toBe(false);
    });
  });
});

describe("validateFixedAsset: 定額法（FR-001〜004、R1、R4）", () => {
  it("US1 シナリオ1の資産は登録できる。少額の特例の基準額・上限の検査はしない", () => {
    const r = validate(straightDraft());
    expect(r.ok && r.value).toMatchObject({ method: "straight_line", usefulLifeYears: 4 });
    // 取得価額が基準額以上でも、年間の上限に達していても登録できる
    const full = [...Array(10).keys()].map((i) =>
      asset({ id: `s-${i}`, acquisitionCost: 299_999, acquiredOn: "2026-05-01" }),
    );
    expect(validate(straightDraft({ acquisitionCost: 5_000_000 }), full).ok).toBe(true);
  });

  it("耐用年数が率の表にない（1 年、51 年）・ない（null）と USEFUL_LIFE_UNSUPPORTED（details に耐用年数と取得日）", () => {
    for (const years of [1, 51, 0, 4.5, null]) {
      const e = errorOf(validate(straightDraft({ usefulLifeYears: years })));
      expect(e.code).toBe("USEFUL_LIFE_UNSUPPORTED");
      expect(e.details).toMatchObject({ usefulLifeYears: years, acquiredOn: "2026-07-10" });
    }
    expect(validate(straightDraft({ usefulLifeYears: 2 })).ok).toBe(true);
    expect(validate(straightDraft({ usefulLifeYears: 50 })).ok).toBe(true);
  });

  it("取得日に適用される率がない（2007-03-31 以前）と USEFUL_LIFE_UNSUPPORTED", () => {
    const e = errorOf(validate(straightDraft({ acquiredOn: "2007-03-31" })));
    expect(e.code).toBe("USEFUL_LIFE_UNSUPPORTED");
    expect(e.details).toMatchObject({ usefulLifeYears: 4, acquiredOn: "2007-03-31" });
    expect(validate(straightDraft({ acquiredOn: "2007-04-01" })).ok).toBe(true);
  });

  it("供用日が取得日より前、日付の形が違えば VALIDATION（field は inServiceOn）", () => {
    for (const inServiceOn of ["2026-07-09", "2026/07/10"]) {
      const e = errorOf(validate(straightDraft({ inServiceOn })));
      expect(e.code).toBe("VALIDATION");
      expect(e.details).toMatchObject({ field: "inServiceOn" });
    }
    expect(validate(straightDraft({ inServiceOn: "2026-07-10" })).ok).toBe(true);
    const later = validate(straightDraft({ inServiceOn: "2026-09-01" }));
    expect(later.ok && later.value.inServiceOn).toBe("2026-09-01");
  });

  it("前年までの累計: 負・非整数・取得価額 − 1 を超える・年がない・年が供用の年より前は PRIOR_ACCUMULATED_INVALID", () => {
    const prior = (priorAccumulated: number, priorThroughYear: number | null) =>
      validate(straightDraft({ priorAccumulated, priorThroughYear }));
    expect(errorOf(prior(-1, 2026)).code).toBe("PRIOR_ACCUMULATED_INVALID");
    expect(errorOf(prior(1.5, 2026)).code).toBe("PRIOR_ACCUMULATED_INVALID");
    expect(errorOf(prior(500_000, 2026)).code).toBe("PRIOR_ACCUMULATED_INVALID");
    expect(errorOf(prior(100, null)).code).toBe("PRIOR_ACCUMULATED_INVALID");
    expect(errorOf(prior(100, 2025)).code).toBe("PRIOR_ACCUMULATED_INVALID");
    const over = errorOf(prior(500_000, 2026));
    expect(over.details).toMatchObject({ field: "priorAccumulated" });
    expect(errorOf(prior(100, 2025)).details).toMatchObject({ field: "priorThroughYear" });
    // 上限ちょうど（取得価額 − 1）、供用の年と同じ年は登録できる
    expect(prior(499_999, 2026).ok).toBe(true);
    expect(prior(100, 2027).ok).toBe(true);
    expect(prior(0, null).ok).toBe(true);
  });

  it("定額法の linkedJournalId は VALIDATION（少額の特例だけに結びつけられる）", () => {
    const e = errorOf(validate(straightDraft({ linkedJournalId: "j-1" })));
    expect(e.code).toBe("VALIDATION");
    expect(e.details).toMatchObject({ field: "linkedJournalId" });
  });

  it("資産の勘定・取得価額・割合の検査は方法によらず効く", () => {
    expect(errorOf(validate(straightDraft({ assetAccountId: DEPRECIATION }))).code).toBe(
      "ASSET_ACCOUNT_INVALID",
    );
    expect(errorOf(validate(straightDraft({ acquisitionCost: 0 }))).code).toBe("VALIDATION");
    expect(errorOf(validate(straightDraft({ businessRatio: 10001 }))).code).toBe("VALIDATION");
  });

  it("定額法は同じ年の少額の特例の年間の上限に数えない（少額の特例だけを数える）", () => {
    const others = [
      ...[...Array(9).keys()].map((i) =>
        asset({ id: `big-${i}`, acquisitionCost: 299_000, acquiredOn: "2025-02-01" }),
      ),
      // 2,691,000 円の少額の特例に、定額法の 1,000,000 円が加わっても上限の集計は変わらない
      asset({
        id: "st",
        method: "straight_line",
        usefulLifeYears: 4,
        acquisitionCost: 1_000_000,
        acquiredOn: "2025-03-01",
      }),
    ];
    expect(validate(draft({ acquisitionCost: 299_000 }), others).ok).toBe(true);
  });
});

describe("validateFixedAsset: 少額の特例の項目（R1）", () => {
  it("累計・累計の年・供用日は指定できない（累計 → PRIOR_ACCUMULATED_INVALID、供用日 → VALIDATION）", () => {
    expect(errorOf(validate(draft({ priorAccumulated: 1, priorThroughYear: 2025 }))).code).toBe(
      "PRIOR_ACCUMULATED_INVALID",
    );
    expect(errorOf(validate(draft({ priorThroughYear: 2025 }))).code).toBe(
      "PRIOR_ACCUMULATED_INVALID",
    );
    const e = errorOf(validate(draft({ inServiceOn: "2025-06-15" })));
    expect(e.code).toBe("VALIDATION");
    expect(e.details).toMatchObject({ field: "inServiceOn" });
  });

  it("累計 0・年 null・供用日 null なら登録できる（003 のとおり）", () => {
    const r = validate(draft());
    expect(r.ok && r.value).toMatchObject({
      inServiceOn: null,
      priorAccumulated: 0,
      priorThroughYear: null,
    });
  });
});

describe("depreciate（FR-021、R7）", () => {
  it("取得した年は取得価額の全額を償却する。割合 100% なら必要経費算入額も全額、未償却残高 0（シナリオ1）", () => {
    expect(depOf(asset(), 2025)).toEqual({
      method: "small_asset_28_2",
      cost: 200_000,
      base: 200_000,
      ratePermille: null,
      months: null,
      openingBookValue: 200_000,
      ordinary: 200_000,
      total: 200_000,
      businessRatio: 10000,
      deductible: 200_000,
      closingBookValue: 0,
      disposalKind: null,
      disposalAmount: 0,
      disposalDeductible: 0,
    });
  });

  it("割合 50% なら償却費は全額、必要経費算入額は 50%（シナリオ4）", () => {
    expect(depOf(asset({ businessRatio: 5000 }), 2025)).toMatchObject({
      total: 200_000,
      deductible: 100_000,
      closingBookValue: 0,
    });
  });

  it("必要経費算入額は円未満を切り捨てる", () => {
    expect(depOf(asset({ acquisitionCost: 100_001, businessRatio: 5000 }), 2025).deductible).toBe(
      50_000,
    );
    expect(depOf(asset({ acquisitionCost: 99_999, businessRatio: 3333 }), 2025).deductible).toBe(
      Math.floor((99_999 * 3333) / 10000),
    );
  });

  it("取得した年以外は償却しない（取得価額と割合は残る）", () => {
    for (const year of [2024, 2026]) {
      expect(depOf(asset(), year)).toEqual({
        method: "small_asset_28_2",
        cost: 200_000,
        base: 0,
        ratePermille: null,
        months: null,
        openingBookValue: 0,
        ordinary: 0,
        total: 0,
        businessRatio: 10000,
        deductible: 0,
        closingBookValue: 0,
        disposalKind: null,
        disposalAmount: 0,
        disposalDeductible: 0,
      });
    }
  });

  it("少額の特例は、率の表・税制の値がなくても計算できる", () => {
    const r = depreciate(asset(), 2025, { rates: [], taxParameters: [] });
    expect(r.ok && r.value.total).toBe(200_000);
  });

  describe("定額法（FR-005〜008、R3）", () => {
    it("US1 シナリオ1: 2026 年は 償却率 0.250・6/12・償却費 62,500・残高 437,500", () => {
      expect(depOf(straight(), 2026)).toEqual({
        method: "straight_line",
        cost: 500_000,
        base: 500_000,
        ratePermille: 250,
        months: 6,
        openingBookValue: 500_000,
        ordinary: 62_500,
        total: 62_500,
        businessRatio: 10000,
        deductible: 62_500,
        closingBookValue: 437_500,
        disposalKind: null,
        disposalAmount: 0,
        disposalDeductible: 0,
      });
    });

    it("US1 シナリオ2: 事業専用割合 60% は 償却費 62,500 のうち必要経費算入額 37,500", () => {
      const d = depOf(straight({ businessRatio: 6000 }), 2026);
      expect(d.total).toBe(62_500);
      expect(d.deductible).toBe(37_500);
    });

    it("翌年度は 12/12 で、期首は前年度の期末（437,500）", () => {
      expect(depOf(straight(), 2027)).toMatchObject({
        months: 12,
        openingBookValue: 437_500,
        total: 125_000,
        closingBookValue: 312_500,
      });
    });

    it("US1 シナリオ4: 前年までの累計の入力は期首の残高になる（累計 120,000、2025 年分まで）", () => {
      const a = straight({
        acquiredOn: "2024-01-15",
        acquisitionCost: 300_000,
        usefulLifeYears: 5,
        priorAccumulated: 120_000,
        priorThroughYear: 2025,
      });
      expect(depOf(a, 2026)).toMatchObject({
        ratePermille: 200,
        months: 12,
        openingBookValue: 180_000,
        total: 60_000,
        closingBookValue: 120_000,
      });
    });

    it("除却の年（廃棄）: 2026-10-05 除却 → 償却 41,667（算入 25,000）、除却額 458,333（事業分 274,999）、期末 0", () => {
      const d = depOf(
        straight({ businessRatio: 6000, disposedOn: "2026-10-05", disposalKind: "scrap" }),
        2026,
      );
      expect(d).toMatchObject({
        months: 4,
        total: 41_667,
        deductible: 25_000,
        disposalKind: "scrap",
        disposalAmount: 458_333,
        disposalDeductible: 274_999,
        closingBookValue: 0,
      });
    });

    it("除却の年（売却）: 除却額は同じで、除却損の事業分（disposalDeductible）は 0", () => {
      const d = depOf(
        straight({ businessRatio: 6000, disposedOn: "2026-10-05", disposalKind: "sale" }),
        2026,
      );
      expect(d).toMatchObject({
        total: 41_667,
        deductible: 25_000,
        disposalKind: "sale",
        disposalAmount: 458_333,
        disposalDeductible: 0,
        closingBookValue: 0,
      });
    });

    it("除却の年以外は disposalKind が null・除却額 0。除却の翌年度は計算しない", () => {
      const a = straight({ disposedOn: "2027-03-31", disposalKind: "scrap" });
      expect(depOf(a, 2026)).toMatchObject({ disposalKind: null, disposalAmount: 0 });
      expect(depOf(a, 2028)).toMatchObject({
        months: 0,
        total: 0,
        deductible: 0,
        openingBookValue: 0,
        closingBookValue: 0,
        disposalAmount: 0,
      });
    });

    it("率がなければ TAX_PARAMETER_MISSING（details.key・date）。耐用年数が表にない場合も同じ", () => {
      const noRates = depreciate(straight(), 2026, { rates: [], taxParameters: TAX_PARAMETERS });
      expect(!noRates.ok && noRates.error.code).toBe("TAX_PARAMETER_MISSING");
      expect(!noRates.ok && noRates.error.details).toMatchObject({
        key: "STRAIGHT_LINE_RATE",
        date: "2026-07-10",
      });
      const outOfTable = depreciate(straight({ usefulLifeYears: 51 }), 2026, params);
      expect(!outOfTable.ok && outOfTable.error.code).toBe("TAX_PARAMETER_MISSING");
      const noLife = depreciate(straight({ usefulLifeYears: null }), 2026, params);
      expect(!noLife.ok && noLife.error.code).toBe("TAX_PARAMETER_MISSING");
    });
  });
});

describe("isDepreciationRow（R11）", () => {
  const row = (a: FixedAsset, year: number, p = params) => isDepreciationRow(a, year, p);

  it("少額の特例は 003 のまま: 取得した年だけ、その年の末日までに除却したら載せない", () => {
    expect(row(asset(), 2025)).toBe(true);
    expect(row(asset(), 2026)).toBe(false);
    expect(row(asset(), 2024)).toBe(false);
    expect(row(asset({ disposedOn: "2025-12-31" }), 2025)).toBe(false);
    expect(row(asset({ disposedOn: "2026-01-01" }), 2025)).toBe(true);
  });

  it("定額法: 供用の年と中間の年に載せる。取得より前の年度には載せない", () => {
    expect(row(straight(), 2026)).toBe(true);
    expect(row(straight(), 2027)).toBe(true);
    expect(row(straight(), 2025)).toBe(false);
  });

  it("定額法: 償却が終わった（残高 1 円で償却費 0）の年度には載せない", () => {
    const a = straight({
      acquiredOn: "2026-01-01",
      acquisitionCost: 1_000_000,
      usefulLifeYears: 10,
    });
    expect(row(a, 2035)).toBe(true);
    expect(row(a, 2036)).toBe(false);
  });

  it("定額法: 除却の年度は、除却の日が年度末より前でも載せる。翌年度からは載せない", () => {
    const a = straight({ disposedOn: "2026-10-05", disposalKind: "scrap" });
    expect(row(a, 2026)).toBe(true);
    expect(row(a, 2027)).toBe(false);
  });

  it("定額法: 取得の年度は償却費が 0 でも載せる（取得価額 1 円）", () => {
    const a = straight({ acquisitionCost: 1 });
    expect(depOf(a, 2026).total).toBe(0);
    expect(row(a, 2026)).toBe(true);
    expect(row(a, 2027)).toBe(false);
  });

  it("定額法: 累計の年以前の年度には載せない（台帳の計算は累計の年の翌年から）", () => {
    const a = straight({
      acquiredOn: "2024-01-15",
      acquisitionCost: 300_000,
      usefulLifeYears: 5,
      priorAccumulated: 120_000,
      priorThroughYear: 2025,
    });
    expect(row(a, 2024)).toBe(false);
    expect(row(a, 2025)).toBe(false);
    expect(row(a, 2026)).toBe(true);
  });

  it("定額法: 率がなく計算できない資産は載せない（警告は buildBlueReturn の役割）", () => {
    expect(row(straight(), 2026, { rates: [], taxParameters: TAX_PARAMETERS })).toBe(false);
  });
});

describe("proposeDepreciationAdjustment（FR-021〜022、INV-23）", () => {
  const propose = (a: FixedAsset, year = 2025) =>
    proposeDepreciationAdjustment(a, year, INDIVIDUAL_ACCOUNT_LIST);
  const proposalOf = (a: FixedAsset, year = 2025) => {
    const r = propose(a, year);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.value;
  };

  it("割合 100% は「減価償却費 / 資産の勘定」だけ。年度末日付、税区分は対象外", () => {
    const p = proposalOf(asset());
    expect(p).toMatchObject({
      kind: "depreciation",
      sourceId: "asset-1",
      breakdown: { acquisitionCost: 200_000, businessRatio: 10000, deductible: 200_000 },
    });
    expect(p?.journal.date).toBe("2025-12-31");
    expect(p?.journal.lines).toEqual([
      { side: "debit", accountId: DEPRECIATION, amount: 200_000, taxCategory: "OUT_OF_SCOPE" },
      { side: "credit", accountId: EQUIPMENT, amount: 200_000, taxCategory: "OUT_OF_SCOPE" },
    ]);
  });

  it("割合 50% は、家事分の「事業主貸 / 減価償却費」が加わる（シナリオ4）", () => {
    const p = proposalOf(asset({ businessRatio: 5000 }));
    expect(p?.journal.lines).toEqual([
      { side: "debit", accountId: DEPRECIATION, amount: 200_000, taxCategory: "OUT_OF_SCOPE" },
      { side: "credit", accountId: EQUIPMENT, amount: 200_000, taxCategory: "OUT_OF_SCOPE" },
      { side: "debit", accountId: DRAWINGS, amount: 100_000, taxCategory: "OUT_OF_SCOPE" },
      { side: "credit", accountId: DEPRECIATION, amount: 100_000, taxCategory: "OUT_OF_SCOPE" },
    ]);
    expect(p?.breakdown).toMatchObject({ deductible: 100_000, businessRatio: 5000 });
  });

  it("割合 0% は全額が家事分", () => {
    const p = proposalOf(asset({ businessRatio: 0 }));
    expect(p?.journal.lines.map((l) => [l.side, l.accountId, l.amount])).toEqual([
      ["debit", DEPRECIATION, 200_000],
      ["credit", EQUIPMENT, 200_000],
      ["debit", DRAWINGS, 200_000],
      ["credit", DEPRECIATION, 200_000],
    ]);
  });

  it("既存の仕訳を結びつけた資産は案を作らない（シナリオ5）", () => {
    expect(proposalOf(asset({ linkedJournalId: "j-1" }))).toBeNull();
  });

  it("取得した年以外、取得した年の末日までに除却した資産は案を作らない", () => {
    expect(proposalOf(asset(), 2026)).toBeNull();
    expect(proposalOf(asset(), 2024)).toBeNull();
    expect(proposalOf(asset({ disposedOn: "2025-12-31" }))).toBeNull();
    expect(proposalOf(asset({ disposedOn: "2026-01-01" }))).not.toBeNull();
  });

  it("事業主貸・減価償却費の科目がなければ ACCOUNT_NOT_FOUND", () => {
    const r = proposeDepreciationAdjustment(
      asset({ businessRatio: 5000 }),
      2025,
      INDIVIDUAL_ACCOUNT_LIST.filter((a) => a.code !== "5180"),
    );
    expect(!r.ok && r.error.code).toBe("ACCOUNT_NOT_FOUND");
  });
});
