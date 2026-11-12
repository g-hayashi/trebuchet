import { describe, expect, it } from "vitest";
import { lumpSumYear } from "../../src/blue-return/lump-sum.ts";
import type { FixedAsset } from "../../src/types.ts";
import { accountIdOf } from "../blue-return-arbitraries.ts";
import { NOW as AT } from "../test-dates.ts";

const YEARS = 3;

/** 一括償却資産（既定: 2026-07-10 に取得・供用、150,000 円） */
const asset = (over: Partial<FixedAsset> = {}): FixedAsset => ({
  id: "asset-1",
  name: "プリンター一式",
  quantity: null,
  acquiredOn: "2026-07-10",
  acquisitionCost: 150_000,
  method: "lump_sum",
  usefulLifeYears: null,
  inServiceOn: null,
  priorAccumulated: 0,
  priorThroughYear: null,
  businessRatio: 10000,
  assetAccountId: accountIdOf("1070"),
  linkedJournalId: null,
  note: null,
  disposedOn: null,
  disposalKind: null,
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

const amounts = (a: FixedAsset, from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => lumpSumYear(a, from + i, YEARS).depreciation);

describe("lumpSumYear（FR-010、R4、data-model §2.2）", () => {
  it("150,000 円は 50,000 円を 3 年度続け、4 年度目は 0（月割りしない）", () => {
    expect(amounts(asset(), 2026, 2029)).toEqual([50_000, 50_000, 50_000, 0]);
    expect(lumpSumYear(asset(), 2026, YEARS)).toEqual({
      openingBookValue: 150_000,
      depreciation: 50_000,
      closingBookValue: 100_000,
    });
    expect(lumpSumYear(asset(), 2028, YEARS)).toEqual({
      openingBookValue: 50_000,
      depreciation: 50_000,
      closingBookValue: 0,
    });
    expect(lumpSumYear(asset(), 2029, YEARS)).toEqual({
      openingBookValue: 0,
      depreciation: 0,
      closingBookValue: 0,
    });
  });

  it("100,000 円は 33,333・33,333・33,334（端数は最終年度に寄せる）", () => {
    expect(amounts(asset({ acquisitionCost: 100_000 }), 2026, 2029)).toEqual([
      33_333, 33_333, 33_334, 0,
    ]);
    expect(amounts(asset({ acquisitionCost: 199_999 }), 2026, 2028)).toEqual([
      66_666, 66_666, 66_667,
    ]);
  });

  it("供用の年から数える（取得の年ではない）。供用の前の年度は償却せず、残高は取得価額のまま", () => {
    const a = asset({ acquiredOn: "2025-12-20", inServiceOn: "2026-02-01" });
    expect(amounts(a, 2025, 2029)).toEqual([0, 50_000, 50_000, 50_000, 0]);
    expect(lumpSumYear(a, 2025, YEARS).closingBookValue).toBe(150_000);
  });

  it("前年までの累計があれば、残りを超えない額で続け、n 年度目で残りをすべて償却する", () => {
    // 2025 年に供用、2025 年分まで 50,000 円償却済み → 2026・2027 年度で残り 100,000 円
    const a = asset({
      acquiredOn: "2025-04-01",
      priorAccumulated: 50_000,
      priorThroughYear: 2025,
    });
    expect(amounts(a, 2025, 2028)).toEqual([0, 50_000, 50_000, 0]);
    expect(lumpSumYear(a, 2026, YEARS).openingBookValue).toBe(100_000);
    // 2026 年分まで 100,000 円償却済み → 2027 年度（3 年度目）で残り 50,000 円
    const b = asset({
      acquiredOn: "2025-04-01",
      priorAccumulated: 100_000,
      priorThroughYear: 2026,
    });
    expect(amounts(b, 2026, 2028)).toEqual([0, 50_000, 0]);
    // 累計が大きく残りが 1 年度分に満たなければ、残りだけ
    const c = asset({
      acquiredOn: "2025-04-01",
      priorAccumulated: 140_000,
      priorThroughYear: 2025,
    });
    expect(amounts(c, 2026, 2028)).toEqual([10_000, 0, 0]);
  });

  it("n 年度目より後の年まで累計の年がある資産は、開始年度に残りをすべて償却する", () => {
    const a = asset({
      acquiredOn: "2025-04-01",
      priorAccumulated: 10_000,
      priorThroughYear: 2029,
    });
    expect(amounts(a, 2029, 2032)).toEqual([0, 140_000, 0, 0]);
  });

  it("累計が取得価額に等しければ、どの年度も 0", () => {
    const a = asset({ priorAccumulated: 150_000, priorThroughYear: 2026 });
    expect(amounts(a, 2026, 2030)).toEqual([0, 0, 0, 0, 0]);
  });

  it("除却の有無・種類にかかわらず同じ額（FR-011）", () => {
    const base = amounts(asset(), 2026, 2030);
    for (const kind of ["scrap", "sale"] as const) {
      const disposed = asset({ disposedOn: "2026-09-30", disposalKind: kind });
      expect(amounts(disposed, 2026, 2030)).toEqual(base);
    }
  });

  it("年数は引数（税制の値）に従う", () => {
    const a = asset({ acquisitionCost: 100_001 });
    const five = Array.from({ length: 6 }, (_, i) => lumpSumYear(a, 2026 + i, 5).depreciation);
    expect(five).toEqual([20_000, 20_000, 20_000, 20_000, 20_001, 0]);
  });
});
