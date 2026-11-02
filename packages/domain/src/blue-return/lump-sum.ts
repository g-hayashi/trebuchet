import { yearOfDate } from "../dates.ts";
import type { FixedAsset } from "../types.ts";
import { assetStartYear } from "./straight-line.ts";

/** 一括償却の 1 年度の計算（009 data-model §2.2。保存しない） */
export type LumpSumYear = {
  /** 期首の未償却残高 */
  openingBookValue: number;
  /** 本年分の償却費 */
  depreciation: number;
  /** 期末の未償却残高 = 期首 − 償却費。次の年度の期首になる */
  closingBookValue: number;
};

/**
 * 一括償却資産の年度の償却（FR-010〜011、R4、INV-56）。`years` は税制の値 `LUMP_SUM_YEARS`（3）。
 *
 * - 1 年度目は事業の用に供した年（供用日がなければ取得日の年）。月割りしない
 * - 1〜n−1 年度目は min(⌊取得価額 / n⌋, 期首の残高)、n 年度目は残りをすべて償却する
 *   （100,000 円なら 33,333・33,333・33,334）。n 年度目の後は 0
 * - 台帳は `assetStartYear`（累計の年の翌年、なければ供用の年）から数え、それより前は計算しない
 *   （償却費 0、残高は 取得価額 − 前年までの累計 のまま）。累計の年が n 年度目より後で残りがある場合は、
 *   開始年度に残りをすべて償却する
 * - 除却（廃棄・売却）で計算を変えない。除却損・振替は出さない（`depreciate` が 0 を返す）
 *
 * 金額は整数だけで計算する
 */
export function lumpSumYear(asset: FixedAsset, fiscalYear: number, years: number): LumpSumYear {
  const start = assetStartYear(asset);
  const initial = asset.acquisitionCost - asset.priorAccumulated;
  if (fiscalYear < start) {
    return { openingBookValue: initial, depreciation: 0, closingBookValue: initial };
  }
  const lastYear = yearOfDate(asset.inServiceOn ?? asset.acquiredOn) + years - 1;
  const finalYear = Math.max(start, lastYear);
  const unit = Math.floor(asset.acquisitionCost / years);
  let opening = initial;
  for (let year = start; year < fiscalYear; year++) {
    opening -= year >= finalYear ? opening : Math.min(unit, opening);
  }
  const depreciation = fiscalYear >= finalYear ? opening : Math.min(unit, opening);
  return {
    openingBookValue: opening,
    depreciation,
    closingBookValue: opening - depreciation,
  };
}
