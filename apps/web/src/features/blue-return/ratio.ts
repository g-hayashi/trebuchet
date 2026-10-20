const REGEX = /^(\d{1,3})(?:\.(\d{0,2}))?$/;

/**
 * 事業専用割合の入力（%、小数第2位まで）を万分率の整数（0〜10000）にする。
 * 浮動小数点を通さず、文字列の整数部と小数部から組み立てる（0.07 × 100 のような誤差を避ける）。
 * 全角の数字と「．」を許す。範囲外、小数第3位以降、数字以外は undefined
 */
export function parsePercentToRatio(raw: string): number | undefined {
  const text = raw
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/．/g, ".")
    .trim();
  const match = REGEX.exec(text);
  if (match === null) return undefined;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  const ratio = whole * 100 + fraction;
  return ratio <= 10000 ? ratio : undefined;
}

/** 万分率の整数を「%」の文字列にする（28.5、30 のように末尾の 0 は落とす） */
export function formatRatioAsPercent(ratio: number): string {
  const whole = Math.floor(ratio / 100);
  const fraction = ratio % 100;
  if (fraction === 0) return String(whole);
  return `${whole}.${String(fraction).padStart(2, "0").replace(/0$/, "")}`;
}
