/** 円の金額を 3 桁区切りで表示する（記号なし） */
export function formatYen(amount: number): string {
  return amount.toLocaleString("ja-JP");
}

/** 金額の入力欄の文字列を数値にする。全角数字とカンマを許す。数値でなければ undefined */
export function parseYenInput(raw: string): number | undefined {
  const normalized = raw
    .replace(/[０-９．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[,，\s]/g, "");
  if (normalized === "") return undefined;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : undefined;
}
