import { computeInclusiveTax } from "../money.ts";

/** 金額・工数の計算（005 R7）。すべて整数で行い、浮動小数で金額を計算しない */

/** 明細の金額 = `floor(数量（半単位の整数）× 単価 / 2)`（INV-37） */
export function itemAmount(quantityHalves: number, unitPrice: number): number {
  return Math.floor((quantityHalves * unitPrice) / 2);
}

/** 時間（0.5 の倍数）を半時間の整数にする。0.5 の倍数でない・負の値は RangeError */
export function hoursToHalves(hours: number): number {
  const halves = hours * 2;
  if (!Number.isInteger(halves) || halves < 0) {
    throw new RangeError(`工数は 0 以上の 0.5 の倍数で指定してください: ${hours}`);
  }
  return halves;
}

export type TaxBreakdownRow = {
  /** 税率（%）。税率なし（免税・対象外）は null */
  rate: number | null;
  /** 税込の合計 */
  inclusive: number;
  /** 税額（税率ごとに 1 回の切り捨て。税率なしは 0） */
  tax: number;
  /** 税抜の小計 = 税込 − 税額 */
  exclusive: number;
};

/** 税率ごとの内訳（請求書の「別記」）。税率の高い順、税率なしは最後 */
export function taxBreakdown(
  items: readonly { amount: number; taxRate: number | null }[],
): TaxBreakdownRow[] {
  const totals = new Map<number | null, number>();
  for (const item of items) {
    totals.set(item.taxRate, (totals.get(item.taxRate) ?? 0) + item.amount);
  }
  return [...totals.entries()]
    .sort(([a], [b]) => {
      if (a === b) return 0;
      if (a === null) return 1;
      if (b === null) return -1;
      return b - a;
    })
    .map(([rate, inclusive]) => {
      const tax = rate === null ? 0 : computeInclusiveTax(inclusive, rate);
      return { rate, inclusive, tax, exclusive: inclusive - tax };
    });
}
