import { describe, expect, it } from "vitest";
import {
  resolveStraightLineRate,
  resolveTaxParameter,
} from "../../src/blue-return/tax-parameters.ts";
import { STRAIGHT_LINE_RATES } from "../../src/seed/depreciation-rates.ts";
import { TAX_PARAMETERS } from "../../src/seed/tax-parameters.ts";
import type { StraightLineRate, TaxParameter } from "../../src/types.ts";

const at = (key: TaxParameter["key"], date: string) =>
  resolveTaxParameter(key, date, TAX_PARAMETERS)?.value;

describe("TAX_PARAMETERS の seed（research R3）", () => {
  it("10行（003 の 6 行と 009 の 4 行）で、すべて出典 URL を持つ", () => {
    expect(TAX_PARAMETERS).toHaveLength(10);
    for (const p of TAX_PARAMETERS) {
      expect(p.sourceUrl).toMatch(/^https:\/\//);
      expect(p.value).toBeGreaterThan(0);
      expect(p.effectiveTo === null || p.effectiveTo >= p.effectiveFrom).toBe(true);
    }
  });
  it("(key, effectiveFrom) は重複しない（PK）", () => {
    const keys = TAX_PARAMETERS.map((p) => `${p.key}|${p.effectiveFrom}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("resolveTaxParameter", () => {
  it("少額減価償却資産の基準額: 2026-03-31 は 300,000、2026-04-01 は 400,000", () => {
    expect(at("SMALL_ASSET_THRESHOLD", "2026-03-31")).toBe(300_000);
    expect(at("SMALL_ASSET_THRESHOLD", "2026-04-01")).toBe(400_000);
    expect(at("SMALL_ASSET_THRESHOLD", "2006-04-01")).toBe(300_000);
  });
  it("適用終了日（両端を含む）: 2029-03-31 は 400,000、2029-04-01 は undefined", () => {
    expect(at("SMALL_ASSET_THRESHOLD", "2029-03-31")).toBe(400_000);
    expect(at("SMALL_ASSET_THRESHOLD", "2029-04-01")).toBeUndefined();
    expect(at("SMALL_ASSET_ANNUAL_LIMIT", "2029-03-31")).toBe(3_000_000);
    expect(at("SMALL_ASSET_ANNUAL_LIMIT", "2029-04-01")).toBeUndefined();
  });
  it("適用開始日より前は undefined", () => {
    expect(at("SMALL_ASSET_THRESHOLD", "2006-03-31")).toBeUndefined();
    expect(at("SMALL_ASSET_ANNUAL_LIMIT", "2006-03-31")).toBe(undefined);
    expect(at("BLUE_DEDUCTION_MAX", "2019-12-31")).toBeUndefined();
  });
  it("青色申告特別控除の3つの値（期限なし）", () => {
    expect(at("BLUE_DEDUCTION_MAX", "2020-01-01")).toBe(650_000);
    expect(at("BLUE_DEDUCTION_STANDARD", "2025-12-31")).toBe(550_000);
    expect(at("BLUE_DEDUCTION_BASIC", "2099-12-31")).toBe(100_000);
  });
  it("適用開始日が日付以前の最新の行を選ぶ（入力の順に依らない）", () => {
    const params: TaxParameter[] = [
      {
        key: "BLUE_DEDUCTION_MAX",
        effectiveFrom: "2030-01-01",
        effectiveTo: null,
        value: 2,
        sourceUrl: "u",
      },
      {
        key: "BLUE_DEDUCTION_MAX",
        effectiveFrom: "2020-01-01",
        effectiveTo: "2029-12-31",
        value: 1,
        sourceUrl: "u",
      },
    ];
    expect(resolveTaxParameter("BLUE_DEDUCTION_MAX", "2029-12-31", params)?.value).toBe(1);
    expect(resolveTaxParameter("BLUE_DEDUCTION_MAX", "2030-01-01", params)?.value).toBe(2);
  });
  it("最新の行の適用終了日を過ぎていれば、古い行へはさかのぼらず undefined", () => {
    const params: TaxParameter[] = [
      {
        key: "BLUE_DEDUCTION_MAX",
        effectiveFrom: "2020-01-01",
        effectiveTo: "2024-12-31",
        value: 1,
        sourceUrl: "u",
      },
      {
        key: "BLUE_DEDUCTION_MAX",
        effectiveFrom: "2025-01-01",
        effectiveTo: "2025-12-31",
        value: 2,
        sourceUrl: "u",
      },
    ];
    expect(resolveTaxParameter("BLUE_DEDUCTION_MAX", "2026-01-01", params)).toBeUndefined();
  });
  it("TaxParameter の行そのものを返す（出典を使える）", () => {
    const p = resolveTaxParameter("BLUE_DEDUCTION_BASIC", "2025-01-01", TAX_PARAMETERS);
    expect(p?.sourceUrl).toContain("2072");
  });
  it("009 の 4 つの key（2007-04-01 から期限なし）が解決できる（R13）", () => {
    expect(at("LUMP_SUM_COST_MIN", "2007-04-01")).toBe(100_000);
    expect(at("LUMP_SUM_COST_MAX", "2030-01-01")).toBe(200_000);
    expect(at("LUMP_SUM_YEARS", "2026-11-01")).toBe(3);
    expect(at("OPENING_COST_AMORTIZATION_MONTHS", "2026-11-01")).toBe(60);
    expect(at("LUMP_SUM_YEARS", "2007-03-31")).toBeUndefined();
    expect(at("OPENING_COST_AMORTIZATION_MONTHS", "2007-03-31")).toBeUndefined();
  });
});

describe("STRAIGHT_LINE_RATES の seed（research R2）", () => {
  it("耐用年数 2〜50 が 1 行ずつで、各値が ⌈1000 / n⌉ と一致する（転記の検算）", () => {
    expect(STRAIGHT_LINE_RATES.map((r) => r.usefulLifeYears)).toEqual(
      Array.from({ length: 49 }, (_, i) => i + 2),
    );
    for (const r of STRAIGHT_LINE_RATES) {
      expect(r.ratePermille, `${r.usefulLifeYears}年`).toBe(Math.ceil(1000 / r.usefulLifeYears));
      expect(r.effectiveFrom).toBe("2007-04-01");
      expect(r.effectiveTo).toBeNull();
      expect(r.sourceUrl).toMatch(/^https:\/\/www\.nta\.go\.jp\//);
    }
  });
  it("表の主な値（別表第八）", () => {
    const rate = (n: number) =>
      STRAIGHT_LINE_RATES.find((r) => r.usefulLifeYears === n)?.ratePermille;
    expect(rate(2)).toBe(500);
    expect(rate(3)).toBe(334);
    expect(rate(4)).toBe(250);
    expect(rate(6)).toBe(167);
    expect(rate(7)).toBe(143);
    expect(rate(10)).toBe(100);
    expect(rate(30)).toBe(34);
    expect(rate(50)).toBe(20);
  });
});

describe("resolveStraightLineRate", () => {
  it("4 年・2007-04-01 以後の取得は 250", () => {
    expect(resolveStraightLineRate(4, "2007-04-01", STRAIGHT_LINE_RATES)?.ratePermille).toBe(250);
    expect(resolveStraightLineRate(4, "2026-11-01", STRAIGHT_LINE_RATES)?.ratePermille).toBe(250);
  });
  it("2007-03-31 の取得は undefined", () => {
    expect(resolveStraightLineRate(4, "2007-03-31", STRAIGHT_LINE_RATES)).toBeUndefined();
  });
  it("表にない耐用年数（1・51）は undefined", () => {
    expect(resolveStraightLineRate(51, "2026-01-01", STRAIGHT_LINE_RATES)).toBeUndefined();
    expect(resolveStraightLineRate(1, "2026-01-01", STRAIGHT_LINE_RATES)).toBeUndefined();
  });
  it("適用開始日・終了日つきの行から、日付に合う最新の行を選ぶ", () => {
    const rows: StraightLineRate[] = [
      {
        usefulLifeYears: 4,
        ratePermille: 300,
        effectiveFrom: "2000-01-01",
        effectiveTo: "2010-12-31",
        sourceUrl: "u",
      },
      {
        usefulLifeYears: 4,
        ratePermille: 250,
        effectiveFrom: "2011-01-01",
        effectiveTo: null,
        sourceUrl: "u",
      },
      {
        usefulLifeYears: 5,
        ratePermille: 200,
        effectiveFrom: "2000-01-01",
        effectiveTo: "2005-12-31",
        sourceUrl: "u",
      },
    ];
    expect(resolveStraightLineRate(4, "2010-12-31", rows)?.ratePermille).toBe(300);
    expect(resolveStraightLineRate(4, "2011-01-01", rows)?.ratePermille).toBe(250);
    expect(resolveStraightLineRate(5, "2006-01-01", rows)).toBeUndefined();
  });
});
