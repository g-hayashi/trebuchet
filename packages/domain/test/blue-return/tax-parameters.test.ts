import { describe, expect, it } from "vitest";
import { resolveTaxParameter } from "../../src/blue-return/tax-parameters.ts";
import { TAX_PARAMETERS } from "../../src/seed/tax-parameters.ts";
import type { TaxParameter } from "../../src/types.ts";

const at = (key: TaxParameter["key"], date: string) =>
  resolveTaxParameter(key, date, TAX_PARAMETERS)?.value;

describe("TAX_PARAMETERS の seed（research R3）", () => {
  it("6行で、すべて出典 URL を持つ", () => {
    expect(TAX_PARAMETERS).toHaveLength(6);
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
});
