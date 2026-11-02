import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { depreciate, proposeDepreciationAdjustment } from "../../src/blue-return/depreciation.ts";
import { lumpSumYear } from "../../src/blue-return/lump-sum.ts";
import { assetStartYear } from "../../src/blue-return/straight-line.ts";
import { yearOfDate } from "../../src/dates.ts";
import { STRAIGHT_LINE_RATES } from "../../src/seed/depreciation-rates.ts";
import { TAX_PARAMETERS } from "../../src/seed/tax-parameters.ts";
import type { FixedAsset } from "../../src/types.ts";
import {
  accountIdOf,
  INDIVIDUAL_ACCOUNT_LIST,
  lumpSumAssetArb,
} from "../blue-return-arbitraries.ts";

const params = { rates: STRAIGHT_LINE_RATES, taxParameters: TAX_PARAMETERS };
const yearsArb = fc.integer({ min: 2, max: 10 });

/** n ≤ 10 年と、累計の年が供用の年の 8 年後でも、償却が終わるまで */
const HORIZON = 25;

const notDisposed = (a: FixedAsset): FixedAsset => ({ ...a, disposedOn: null, disposalKind: null });

describe("INV-56: 一括償却の年度の額", () => {
  it("各年度の額は 0 以上の整数で、開始年度からの合計 = 取得価額 − 前年までの累計。n 年度目の後は 0", () => {
    fc.assert(
      fc.property(lumpSumAssetArb, yearsArb, (asset, years) => {
        const start = assetStartYear(asset);
        const lastYear = yearOfDate(asset.inServiceOn ?? asset.acquiredOn) + years - 1;
        let total = 0;
        for (let year = start; year < start + HORIZON; year++) {
          const y = lumpSumYear(asset, year, years);
          expect(Number.isInteger(y.depreciation)).toBe(true);
          expect(y.depreciation).toBeGreaterThanOrEqual(0);
          expect(y.closingBookValue).toBe(y.openingBookValue - y.depreciation);
          expect(y.closingBookValue).toBeGreaterThanOrEqual(0);
          expect(lumpSumYear(asset, year + 1, years).openingBookValue).toBe(y.closingBookValue);
          if (year > Math.max(start, lastYear)) expect(y.depreciation).toBe(0);
          total += y.depreciation;
        }
        expect(total).toBe(asset.acquisitionCost - asset.priorAccumulated);
        expect(lumpSumYear(asset, start + HORIZON, years).closingBookValue).toBe(0);
      }),
    );
  });

  it("累計がなければ、供用の年から n 年度続き、最初の n − 1 年度は ⌊取得価額 / n⌋", () => {
    fc.assert(
      fc.property(lumpSumAssetArb, yearsArb, (generated, years) => {
        const asset: FixedAsset = { ...generated, priorAccumulated: 0, priorThroughYear: null };
        const first = yearOfDate(asset.inServiceOn ?? asset.acquiredOn);
        const unit = Math.floor(asset.acquisitionCost / years);
        for (let k = 1; k < years; k++) {
          expect(lumpSumYear(asset, first + k - 1, years).depreciation).toBe(unit);
        }
        expect(lumpSumYear(asset, first + years - 1, years).depreciation).toBe(
          asset.acquisitionCost - (years - 1) * unit,
        );
        expect(lumpSumYear(asset, first + years, years).depreciation).toBe(0);
      }),
    );
  });

  it("除却しても各年度の額は変わらない（廃棄・売却とも）", () => {
    fc.assert(
      fc.property(lumpSumAssetArb, yearsArb, (asset, years) => {
        const start = assetStartYear(asset);
        const kept = notDisposed(asset);
        for (let year = start; year < start + HORIZON; year++) {
          expect(lumpSumYear(asset, year, years)).toEqual(lumpSumYear(kept, year, years));
        }
      }),
    );
  });

  it("depreciate は除却しても額が同じで、除却額・除却損は常に 0。仕訳の案に除却損の行も事業主貸への振替もない", () => {
    const LOSS = accountIdOf("5300");
    fc.assert(
      fc.property(lumpSumAssetArb, (asset) => {
        const start = assetStartYear(asset);
        const kept = notDisposed(asset);
        for (let year = start; year < start + 6; year++) {
          const r = depreciate(asset, year, params);
          const k = depreciate(kept, year, params);
          if (!r.ok || !k.ok) throw new Error("計算できるはず");
          expect(r.value.total).toBe(k.value.total);
          expect(r.value.closingBookValue).toBe(k.value.closingBookValue);
          expect(r.value.disposalAmount).toBe(0);
          expect(r.value.disposalDeductible).toBe(0);
          expect(r.value.disposalKind).toBeNull();

          const proposal = proposeDepreciationAdjustment(
            asset,
            year,
            INDIVIDUAL_ACCOUNT_LIST,
            params,
          );
          if (!proposal.ok) throw new Error("案を作れるはず");
          if (proposal.value === null) {
            expect(r.value.total).toBe(0);
            continue;
          }
          const lines = proposal.value.journal.lines;
          expect(lines.some((l) => l.accountId === LOSS)).toBe(false);
          expect(proposal.value.breakdown).toMatchObject({
            disposalKind: null,
            disposalAmount: 0,
            disposalDeductible: 0,
          });
          // 資産の勘定の貸方 = 償却費だけ
          const credit = lines
            .filter((l) => l.side === "credit" && l.accountId === asset.assetAccountId)
            .reduce((s, l) => s + l.amount, 0);
          expect(credit).toBe(r.value.total);
        }
      }),
    );
  });
});
