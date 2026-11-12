/** 文字列のコードポイント順（UTF-16 のコード単位順）の比較。ロケールに依らず並びが決まる */
export const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** 前後の空白を除く。空（または未指定）なら null */
export const blankToNull = (s: string | null | undefined): string | null => {
  const t = s?.trim() ?? "";
  return t === "" ? null : t;
};
