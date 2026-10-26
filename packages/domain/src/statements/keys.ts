import { normalizeContent } from "./normalize.ts";

/** キーを作る明細の項目（貼り付けの行・保存した明細のどちらでもよい） */
export type KeyedRow = { accountName: string; date: string; amount: number; content: string };

/**
 * 明細の安定したキー（006 R3）= `口座名|日付|金額|正規化した内容|n`。ハッシュにしない
 * （domain に暗号の関数を持ち込まない）。`n` は同じ組の中での出現の順（0 から）
 */
export function stableKey(row: KeyedRow, occurrence: number): string {
  return `${row.accountName}|${row.date}|${row.amount}|${normalizeContent(row.content)}|${occurrence}`;
}

/**
 * 行の並びにキーを振る（入力と同じ順・同じ長さ）。同じ口座・日付・金額・正規化した内容の行には、
 * 出現の順に `n` を振る。同じ組の行を入れ替えてもキーの集合は変わらない（INV-40）
 */
export function assignKeys(rows: readonly KeyedRow[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const base = stableKey(row, 0).slice(0, -2); // 末尾の `|0` を除いた組の識別
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `${base}|${n}`;
  });
}
