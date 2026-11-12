import { describe, expect, it } from "vitest";
import {
  assetStartYear,
  serviceMonths,
  straightLineYear,
} from "../../src/blue-return/straight-line.ts";
import type { FixedAsset } from "../../src/types.ts";
import { accountIdOf } from "../blue-return-arbitraries.ts";
import { NOW as AT } from "../test-dates.ts";

/** 定額法の資産（既定: 2026-07-10 に取得・供用、500,000 円、耐用年数 4 年） */
const asset = (over: Partial<FixedAsset> = {}): FixedAsset => ({
  id: "asset-1",
  name: "機材A",
  quantity: null,
  acquiredOn: "2026-07-10",
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

const RATE_4Y = 250;

describe("assetStartYear（R1）", () => {
  it("累計の年がなければ供用の年（供用日がなければ取得日の年）", () => {
    expect(assetStartYear(asset())).toBe(2026);
    expect(assetStartYear(asset({ acquiredOn: "2025-12-20", inServiceOn: "2026-01-05" }))).toBe(
      2026,
    );
  });
  it("累計の年があればその翌年", () => {
    expect(
      assetStartYear(
        asset({ acquiredOn: "2024-01-15", priorAccumulated: 120_000, priorThroughYear: 2025 }),
      ),
    ).toBe(2026);
  });
});

describe("serviceMonths（FR-006、R3）", () => {
  it("供用の年は供用の月から 12 月まで（7 月供用は 6 か月、月の途中は 1 か月と数える）", () => {
    expect(serviceMonths(asset(), 2026)).toBe(6);
    expect(serviceMonths(asset({ acquiredOn: "2026-07-31" }), 2026)).toBe(6);
  });
  it("12 月供用は 1 か月、1 月供用は 12 か月", () => {
    expect(serviceMonths(asset({ acquiredOn: "2026-12-31" }), 2026)).toBe(1);
    expect(serviceMonths(asset({ acquiredOn: "2026-01-01" }), 2026)).toBe(12);
  });
  it("供用日があれば取得日ではなく供用日の月から数える", () => {
    const a = asset({ acquiredOn: "2026-03-05", inServiceOn: "2026-09-01" });
    expect(serviceMonths(a, 2026)).toBe(4);
  });
  it("供用の翌年以後は 12 か月、供用の前の年度は 0", () => {
    expect(serviceMonths(asset(), 2027)).toBe(12);
    expect(serviceMonths(asset(), 2025)).toBe(0);
    // 取得は 2025 年でも、供用が 2026 年なら 2025 年度は 0
    const late = asset({ acquiredOn: "2025-12-20", inServiceOn: "2026-02-01" });
    expect(serviceMonths(late, 2025)).toBe(0);
    expect(serviceMonths(late, 2026)).toBe(11);
  });
  it("除却の年は除却の月まで（10 月除却は、7 月供用の年で 4 か月、翌年の除却は 1〜除却の月）", () => {
    expect(serviceMonths(asset({ disposedOn: "2026-10-05" }), 2026)).toBe(4);
    expect(serviceMonths(asset({ disposedOn: "2027-03-31" }), 2027)).toBe(3);
    // 供用の月に除却したら 1 か月
    expect(serviceMonths(asset({ disposedOn: "2026-07-31" }), 2026)).toBe(1);
  });
  it("除却の翌年度以後は 0", () => {
    const a = asset({ disposedOn: "2027-03-31" });
    expect(serviceMonths(a, 2028)).toBe(0);
    expect(serviceMonths(a, 2040)).toBe(0);
  });
});

describe("straightLineYear（FR-005〜007、R3、INV-55）", () => {
  it("US1 シナリオ1: 500,000 円・4 年・7 月供用 → 6/12、償却費 62,500、残高 437,500", () => {
    expect(straightLineYear(asset(), 2026, RATE_4Y)).toEqual({
      months: 6,
      openingBookValue: 500_000,
      depreciation: 62_500,
      disposalAmount: 0,
      closingBookValue: 437_500,
    });
  });

  it("翌年度は 12/12 で 125,000、期首は前年度の期末", () => {
    expect(straightLineYear(asset(), 2027, RATE_4Y)).toEqual({
      months: 12,
      openingBookValue: 437_500,
      depreciation: 125_000,
      disposalAmount: 0,
      closingBookValue: 312_500,
    });
  });

  it("No.2106 の例: 1,000,000 円・10 年・1 月供用 → 毎年 100,000、10 年目 99,999、残高 1", () => {
    const a = asset({ acquiredOn: "2026-01-01", acquisitionCost: 1_000_000, usefulLifeYears: 10 });
    for (let year = 2026; year <= 2034; year++) {
      const y = straightLineYear(a, year, 100);
      expect(y.months).toBe(12);
      expect(y.depreciation).toBe(100_000);
    }
    expect(straightLineYear(a, 2035, 100)).toEqual({
      months: 12,
      openingBookValue: 100_000,
      depreciation: 99_999,
      disposalAmount: 0,
      closingBookValue: 1,
    });
  });

  it("US1 シナリオ3: 残高 1 円になった後は償却費 0 で、残高は 1 円のまま", () => {
    const a = asset({ acquiredOn: "2026-01-01", acquisitionCost: 1_000_000, usefulLifeYears: 10 });
    expect(straightLineYear(a, 2036, 100)).toEqual({
      months: 12,
      openingBookValue: 1,
      depreciation: 0,
      disposalAmount: 0,
      closingBookValue: 1,
    });
    expect(straightLineYear(a, 2050, 100).depreciation).toBe(0);
  });

  it("端数は切り上げる（1 円未満。取得価額 100,001 円・耐用年数 3 年（334）・12 月供用）", () => {
    const a = asset({ acquiredOn: "2026-12-01", acquisitionCost: 100_001, usefulLifeYears: 3 });
    // 100,001 × 334 × 1 / 12,000 = 2,783.3 → 2,784
    expect(straightLineYear(a, 2026, 334).depreciation).toBe(2_784);
  });

  it("US1 シナリオ4: 前年までの累計の入力（2024 年取得・300,000 円・5 年・累計 120,000 は 2025 年分まで）→ 2026 年は 12/12、期首 180,000、償却費 60,000、期末 120,000", () => {
    const a = asset({
      acquiredOn: "2024-01-15",
      acquisitionCost: 300_000,
      usefulLifeYears: 5,
      priorAccumulated: 120_000,
      priorThroughYear: 2025,
    });
    expect(straightLineYear(a, 2026, 200)).toEqual({
      months: 12,
      openingBookValue: 180_000,
      depreciation: 60_000,
      disposalAmount: 0,
      closingBookValue: 120_000,
    });
  });

  it("累計の年より前の年度は計算しない（償却費 0、月数 0、残高は 取得価額 − 累計 のまま）", () => {
    const a = asset({
      acquiredOn: "2024-01-15",
      acquisitionCost: 300_000,
      usefulLifeYears: 5,
      priorAccumulated: 120_000,
      priorThroughYear: 2025,
    });
    expect(straightLineYear(a, 2025, 200)).toEqual({
      months: 0,
      openingBookValue: 180_000,
      depreciation: 0,
      disposalAmount: 0,
      closingBookValue: 180_000,
    });
  });

  it("12 月供用は 1/12: 500,000 × 0.250 × 1/12 = 10,416.67 → 10,417", () => {
    const a = asset({ acquiredOn: "2026-12-31" });
    expect(straightLineYear(a, 2026, RATE_4Y)).toMatchObject({
      months: 1,
      depreciation: 10_417,
      closingBookValue: 489_583,
    });
  });

  it("除却の年（US1 シナリオ6・7）: 2026-10-05 に除却 → 7〜10 月の 4/12 で償却 41,667、残高 458,333 は disposalAmount、期末 0", () => {
    const a = asset({ disposedOn: "2026-10-05", disposalKind: "scrap" });
    expect(straightLineYear(a, 2026, RATE_4Y)).toEqual({
      months: 4,
      openingBookValue: 500_000,
      depreciation: 41_667,
      disposalAmount: 458_333,
      closingBookValue: 0,
    });
  });

  it("廃棄・売却のどちらでも straightLineYear の値は同じ（分岐は proposeDepreciationAdjustment）", () => {
    const base = asset({ disposedOn: "2026-10-05" });
    expect(straightLineYear({ ...base, disposalKind: "sale" }, 2026, RATE_4Y)).toEqual(
      straightLineYear({ ...base, disposalKind: "scrap" }, 2026, RATE_4Y),
    );
  });

  it("供用の翌年以後に除却: 期首から除却の月までの月割り（3 月除却は 3/12）", () => {
    const a = asset({ disposedOn: "2027-03-31", disposalKind: "scrap" });
    // 500,000 × 0.25 × 3 / 12 = 31,250
    expect(straightLineYear(a, 2027, RATE_4Y)).toEqual({
      months: 3,
      openingBookValue: 437_500,
      depreciation: 31_250,
      disposalAmount: 406_250,
      closingBookValue: 0,
    });
  });

  it("除却の翌年度以後は計算しない（すべて 0）", () => {
    const a = asset({ disposedOn: "2027-03-31", disposalKind: "scrap" });
    expect(straightLineYear(a, 2028, RATE_4Y)).toEqual({
      months: 0,
      openingBookValue: 0,
      depreciation: 0,
      disposalAmount: 0,
      closingBookValue: 0,
    });
  });

  it("除却の年でも最終年の規則（残高 − 1 円）が効く", () => {
    const a = asset({
      acquiredOn: "2026-01-01",
      acquisitionCost: 1_000_000,
      usefulLifeYears: 10,
      disposedOn: "2035-12-31",
      disposalKind: "scrap",
    });
    expect(straightLineYear(a, 2035, 100)).toMatchObject({
      depreciation: 99_999,
      disposalAmount: 1,
      closingBookValue: 0,
    });
  });
});
