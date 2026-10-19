/** 円の金額を 3 桁区切りで表示する（記号なし） */
export function formatYen(amount: number): string {
  return amount.toLocaleString("ja-JP");
}

/** 帳票の金額を 3 桁区切りで表示する。マイナスは ▲ を付ける（決算書の表記） */
export function formatSignedYen(amount: number): string {
  return amount < 0 ? `▲${formatYen(-amount)}` : formatYen(amount);
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

/** ISO 8601 の日時を、ローカル時刻の「2026/10/31 18:00」の形で表示する */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
