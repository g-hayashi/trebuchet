import type { StraightLineRate } from "../types.ts";

const NTA_RATE_TABLE =
  "https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf";

/** 2007-04-01 以後に取得した資産の定額法の償却率（耐用年数省令 別表第八）。千分率 */
const RATES_PERMILLE: readonly (readonly [usefulLifeYears: number, ratePermille: number])[] = [
  [2, 500],
  [3, 334],
  [4, 250],
  [5, 200],
  [6, 167],
  [7, 143],
  [8, 125],
  [9, 112],
  [10, 100],
  [11, 91],
  [12, 84],
  [13, 77],
  [14, 72],
  [15, 67],
  [16, 63],
  [17, 59],
  [18, 56],
  [19, 53],
  [20, 50],
  [21, 48],
  [22, 46],
  [23, 44],
  [24, 42],
  [25, 40],
  [26, 39],
  [27, 38],
  [28, 36],
  [29, 35],
  [30, 34],
  [31, 33],
  [32, 32],
  [33, 31],
  [34, 30],
  [35, 29],
  [36, 28],
  [37, 28],
  [38, 27],
  [39, 26],
  [40, 25],
  [41, 25],
  [42, 24],
  [43, 24],
  [44, 23],
  [45, 23],
  [46, 22],
  [47, 22],
  [48, 21],
  [49, 21],
  [50, 20],
];

/**
 * 定額法の償却率の正本（Constitution VI、009 research R2、data-model §1.1）。
 * DB へはマイグレーション 0012_depreciation_integrity で投入する（一致を db のテストで確認）。
 * 償却率は法令の表が正本で、計算の式（⌈1000 / 耐用年数⌉）で代えない。
 * 改正があれば、こことマイグレーションの両方に適用の期間つきの行を足す。
 */
export const STRAIGHT_LINE_RATES: readonly StraightLineRate[] = RATES_PERMILLE.map(
  ([usefulLifeYears, ratePermille]) => ({
    usefulLifeYears,
    ratePermille,
    effectiveFrom: "2007-04-01",
    effectiveTo: null,
    sourceUrl: NTA_RATE_TABLE,
  }),
);
