import { monthIndex, monthOfDate, yearOfDate } from "../dates.ts";
import type { FixedAsset } from "../types.ts";

/** 定額法の 1 年度の計算（009 data-model §2.2。保存しない） */
export type StraightLineYear = {
  /** その年度に事業に使った月数（1〜12。使っていない年度・除却の翌年度以後は 0） */
  months: number;
  /** 期首の未償却残高 */
  openingBookValue: number;
  /** 本年分の償却費 */
  depreciation: number;
  /** 除却の年度の、償却の後の未償却残高（備忘価額の 1 円を含む）。除却の年度以外は 0 */
  disposalAmount: number;
  /** 期末の未償却残高 = 期首 − 償却費 − 除却額。次の年度の期首になる */
  closingBookValue: number;
};

/** 率は千分率、年の月数は 12 で割る（÷ 12,000） */
const RATE_DIVISOR = 12_000;

/** 事業の用に供した日（なければ取得日） */
const serviceDateOf = (asset: FixedAsset): string => asset.inServiceOn ?? asset.acquiredOn;

/** 切上げの整数の割り算（n ≥ 0。浮動小数の商を使わない） */
function ceilDiv(n: number, divisor: number): number {
  const remainder = n % divisor;
  return (n - remainder) / divisor + (remainder > 0 ? 1 : 0);
}

/**
 * 台帳が計算を始める年度（R1）。前年までの累計の年があればその翌年、なければ供用の年
 * （供用日がなければ取得日の年）。これより前の年度は計算しない
 */
export function assetStartYear(asset: FixedAsset): number {
  return asset.priorThroughYear !== null
    ? asset.priorThroughYear + 1
    : yearOfDate(serviceDateOf(asset));
}

/**
 * その年度に事業に使った月数（FR-006、R3）。供用の年は供用の月から、除却の年は除却の月まで
 * （月の途中は 1 か月と数える）、他の年は 1〜12 月。使っていない年度（供用の前、除却の翌年度以後）は 0
 */
export function serviceMonths(asset: FixedAsset, fiscalYear: number): number {
  const serviceOn = serviceDateOf(asset);
  const disposedYear = asset.disposedOn === null ? null : yearOfDate(asset.disposedOn);
  if (fiscalYear < yearOfDate(serviceOn)) return 0;
  if (disposedYear !== null && fiscalYear > disposedYear) return 0;
  const year = String(fiscalYear).padStart(4, "0");
  const first = monthIndex(
    fiscalYear === yearOfDate(serviceOn) ? monthOfDate(serviceOn) : `${year}-01`,
  );
  const last = monthIndex(
    asset.disposedOn !== null && fiscalYear === disposedYear
      ? monthOfDate(asset.disposedOn)
      : `${year}-12`,
  );
  return Math.max(0, last - first + 1);
}

/**
 * 定額法の年度の償却（FR-005〜007、R3、INV-55）。`ratePermille` は解決済みの償却率（千分率）。
 * 台帳の計算は `assetStartYear` から積み上げる。
 *
 * - 償却費 = min(⌈取得価額 × 率 × 月数 / 12,000⌉, 期首の残高 − 1)（最終の年度は残高 − 1 円。残高が 1 円なら 0）
 * - 期首（開始年度）= 取得価額 − 前年までの累計。以後は前年度の期末
 * - 除却の年度は `disposalAmount` = 償却の後の残高で、期末は 0。翌年度以後は全部 0。
 *   廃棄・売却の分岐（除却損か事業主貸か）は `proposeDepreciationAdjustment` が行う
 * - 開始年度より前は計算しない（月数・償却費 0、残高は 取得価額 − 累計 のまま）
 *
 * 金額は整数だけで計算する（金額 < 10^12、率 ≤ 500、月数 ≤ 12 の積は 6 × 10^15 で安全な整数に収まる）
 */
export function straightLineYear(
  asset: FixedAsset,
  fiscalYear: number,
  ratePermille: number,
): StraightLineYear {
  const start = assetStartYear(asset);
  const initial = asset.acquisitionCost - asset.priorAccumulated;
  if (fiscalYear < start) {
    return {
      months: 0,
      openingBookValue: initial,
      depreciation: 0,
      disposalAmount: 0,
      closingBookValue: initial,
    };
  }
  const disposedYear = asset.disposedOn === null ? null : yearOfDate(asset.disposedOn);
  const step = (year: number, opening: number): StraightLineYear => {
    if (disposedYear !== null && year > disposedYear) {
      return {
        months: 0,
        openingBookValue: 0,
        depreciation: 0,
        disposalAmount: 0,
        closingBookValue: 0,
      };
    }
    const months = serviceMonths(asset, year);
    const candidate = ceilDiv(asset.acquisitionCost * ratePermille * months, RATE_DIVISOR);
    const depreciation = Math.max(0, Math.min(candidate, opening - 1));
    const disposalAmount = disposedYear === year ? opening - depreciation : 0;
    return {
      months,
      openingBookValue: opening,
      depreciation,
      disposalAmount,
      closingBookValue: opening - depreciation - disposalAmount,
    };
  };
  let opening = initial;
  for (let year = start; year < fiscalYear; year++) {
    opening = step(year, opening).closingBookValue;
  }
  return step(fiscalYear, opening);
}
