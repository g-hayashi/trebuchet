import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  assetStartYear,
  serviceMonths,
  straightLineYear,
} from "../../src/blue-return/straight-line.ts";
import { resolveStraightLineRate } from "../../src/blue-return/tax-parameters.ts";
import { STRAIGHT_LINE_RATES } from "../../src/seed/depreciation-rates.ts";
import type { FixedAsset } from "../../src/types.ts";
import { straightLineAssetArb } from "../blue-return-arbitraries.ts";

const rateOf = (asset: FixedAsset): number => {
  const rate = resolveStraightLineRate(
    asset.usefulLifeYears ?? 0,
    asset.acquiredOn,
    STRAIGHT_LINE_RATES,
  );
  if (rate === undefined) throw new Error("償却率がありません");
  return rate.ratePermille;
};

/** 耐用年数 50 年でも、供用の年が 1 か月でも、償却が終わる 60 年先まで */
const HORIZON = 60;

describe("INV-55: 定額法の年度の計算", () => {
  it("各年度 0 ≤ 償却費 ≤ 期首の残高 − 1、月数は 0〜12、期末 = 期首 − 償却費 − 除却額、期末 = 翌年度の期首", () => {
    fc.assert(
      fc.property(straightLineAssetArb, (asset) => {
        const rate = rateOf(asset);
        const start = assetStartYear(asset);
        for (let year = start; year < start + HORIZON; year++) {
          const y = straightLineYear(asset, year, rate);
          const next = straightLineYear(asset, year + 1, rate);
          expect(y.months).toBe(serviceMonths(asset, year));
          expect(y.months).toBeGreaterThanOrEqual(0);
          expect(y.months).toBeLessThanOrEqual(12);
          expect(Number.isInteger(y.depreciation)).toBe(true);
          expect(y.depreciation).toBeGreaterThanOrEqual(0);
          expect(y.depreciation).toBeLessThanOrEqual(Math.max(0, y.openingBookValue - 1));
          expect(y.closingBookValue).toBe(y.openingBookValue - y.depreciation - y.disposalAmount);
          expect(next.openingBookValue).toBe(y.closingBookValue);
          expect(y.closingBookValue).toBeGreaterThanOrEqual(0);
        }
      }),
    );
  });

  it("供用の年から償却する資産の月数は 1〜12（使っていない年度だけ 0）", () => {
    fc.assert(
      fc.property(straightLineAssetArb, (asset) => {
        const rate = rateOf(asset);
        for (let year = assetStartYear(asset); year < assetStartYear(asset) + HORIZON; year++) {
          const y = straightLineYear(asset, year, rate);
          const disposedBefore =
            asset.disposedOn !== null && year > Number(asset.disposedOn.slice(0, 4));
          expect(y.months === 0).toBe(disposedBefore);
        }
      }),
    );
  });

  it("除却しなければ、償却費の合計 = 取得価額 − 前年までの累計 − 1（償却が止まるまで）", () => {
    fc.assert(
      fc.property(straightLineAssetArb, (generated) => {
        const asset: FixedAsset = { ...generated, disposedOn: null, disposalKind: null };
        const rate = rateOf(asset);
        const start = assetStartYear(asset);
        let total = 0;
        for (let year = start; year < start + HORIZON; year++) {
          const y = straightLineYear(asset, year, rate);
          expect(y.disposalAmount).toBe(0);
          total += y.depreciation;
        }
        expect(total).toBe(asset.acquisitionCost - asset.priorAccumulated - 1);
        expect(straightLineYear(asset, start + HORIZON, rate).openingBookValue).toBe(1);
      }),
    );
  });

  it("除却すれば（廃棄・売却とも）除却の年度の期末は 0、除却額はその年度だけ、翌年度以後は全部 0", () => {
    fc.assert(
      fc.property(straightLineAssetArb, (asset) => {
        fc.pre(asset.disposedOn !== null);
        const rate = rateOf(asset);
        const disposalYear = Number(asset.disposedOn?.slice(0, 4));
        const start = assetStartYear(asset);
        for (let year = start; year < start + HORIZON; year++) {
          const y = straightLineYear(asset, year, rate);
          if (year < disposalYear) {
            expect(y.disposalAmount).toBe(0);
            expect(y.closingBookValue).toBeGreaterThanOrEqual(1);
          } else if (year === disposalYear) {
            expect(y.closingBookValue).toBe(0);
            expect(y.disposalAmount).toBe(y.openingBookValue - y.depreciation);
            // 備忘価額の 1 円も除却額に含まれる
            expect(y.disposalAmount).toBeGreaterThanOrEqual(1);
          } else {
            expect(y).toEqual({
              months: 0,
              openingBookValue: 0,
              depreciation: 0,
              disposalAmount: 0,
              closingBookValue: 0,
            });
          }
        }
      }),
    );
  });
});
