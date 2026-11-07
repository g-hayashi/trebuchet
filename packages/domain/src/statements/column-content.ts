import type { StatementColumnIndexes } from "@trebuchet/schema";
import { firstLine, parseStatementAmount, parseStatementDate } from "./table.ts";

/**
 * 列の案を、見本の行の値で確かめる（007/R16）。端末内の AI の案は誤ることがあるので、採用する前に、
 * 合わない役割を捨て（`dropMismatchedColumns`）、案のない日付・金額・内容を中身から推定する（`inferMissingColumns`）。
 * 値は読むだけで、帳簿には書かない。推定は案であり、利用者が確かめて確定する（FR-004）。AI のプロンプトは変えない
 */

type Rows = readonly (readonly string[])[];

/** 空でないセル（前後の空白を除いて空でないもの）。列が行にない（短い行）ときは空のセル扱い */
const cellsOf = (rows: Rows, index: number): string[] =>
  rows.map((r) => r[index] ?? "").filter((c) => c.trim() !== "");

/** 日付として読めるセルか（年のない日付・2 桁の年も含む） */
const isDate = (cell: string): boolean => parseStatementDate(cell, 2000) !== undefined;

/** 金額として読めるセルか。日付・年月（`26/11`）・文字は不可。改行でつながったセルは 1 行目で読む */
const isAmount = (cell: string): boolean =>
  typeof parseStatementAmount(firstLine(cell)) === "number";

/** 空でないセルのうち、過半（半数を超える）が条件を満たすか。空でないセルがなければ判断できないので false */
const mostly = (cells: readonly string[], test: (cell: string) => boolean): boolean =>
  cells.length > 0 && cells.filter(test).length * 2 > cells.length;

const ratio = (cells: readonly string[], test: (cell: string) => boolean): number =>
  cells.length === 0 ? 0 : cells.filter(test).length / cells.length;

/**
 * 見本の行の値と合わない役割を捨てる: date は空でないセルの過半が日付として読めない、amount・outflow・inflow は
 * 過半が金額として読めないとき。空でないセルがなければ判断せず残す。出金・入金は対なので、片方を捨てたらもう片方も捨てる。
 * ほかの役割（内容・メモなど）は検査しない
 */
export function dropMismatchedColumns(
  columns: StatementColumnIndexes,
  rows: Rows,
): StatementColumnIndexes {
  const kept: StatementColumnIndexes = { ...columns };
  const checks = [
    ["date", isDate],
    ["amount", isAmount],
    ["outflow", isAmount],
    ["inflow", isAmount],
  ] as const;
  for (const [role, test] of checks) {
    const index = columns[role];
    if (index === undefined) continue;
    const cells = cellsOf(rows, index);
    if (cells.length > 0 && !mostly(cells, test)) delete kept[role];
  }
  if (
    columns.outflow !== undefined &&
    columns.inflow !== undefined &&
    (kept.outflow === undefined || kept.inflow === undefined)
  ) {
    delete kept.outflow;
    delete kept.inflow;
  }
  return kept;
}

/** 推定が取らない列の役割（別の役割の列は取らない。メモ・大項目などの案の列は、中身が合えば取ってよい） */
const PROTECTED_ROLES = ["date", "content", "amount", "outflow", "inflow"] as const;

/** 条件を満たす列のうち、`score` が最大のもの（同点は左）。`score` が undefined の列は候補にしない */
function bestColumn(
  indexes: readonly number[],
  score: (index: number) => number | undefined,
): number | undefined {
  let best: { index: number; score: number } | undefined;
  for (const index of indexes) {
    const s = score(index);
    if (s !== undefined && (best === undefined || s > best.score)) best = { index, score: s };
  }
  return best?.index;
}

/**
 * 案（`known`。辞書の案と AI の案）のない日付・金額・内容を、見本の行の中身から推定して返す（足す分だけ。`known` は含めない）:
 * - date: 日付として読める割合が最大で過半の列（同じ割合なら左）
 * - amount: 金額 1 列のとき（`known` に amount・outflow・inflow がない）だけ。金額として読める割合が過半で、日付の列でない最も左の列
 * - content: 日付・金額でない文字の列（過半が文字）で、空でないセルの平均の長さが最大の列（同じなら左）
 * 日付・内容・金額・出金・入金の案の列は取らない。推定の列は、すでに推定した役割の列とも重ならない
 */
export function inferMissingColumns(
  known: StatementColumnIndexes,
  rows: Rows,
  columnCount: number,
): StatementColumnIndexes {
  const added: StatementColumnIndexes = {};
  const used = new Set<number>(
    PROTECTED_ROLES.flatMap((role) => (known[role] === undefined ? [] : [known[role]])),
  );
  const indexes = Array.from({ length: columnCount }, (_, i) => i);
  const free = () => indexes.filter((i) => !used.has(i));
  const dateLike = (i: number) => mostly(cellsOf(rows, i), isDate);

  if (known.date === undefined) {
    const date = bestColumn(free(), (i) => {
      const r = ratio(cellsOf(rows, i), isDate);
      return r * 2 > 1 ? r : undefined;
    });
    if (date !== undefined) {
      added.date = date;
      used.add(date);
    }
  }

  if (known.amount === undefined && known.outflow === undefined && known.inflow === undefined) {
    const amount = free().find((i) => !dateLike(i) && mostly(cellsOf(rows, i), isAmount));
    if (amount !== undefined) {
      added.amount = amount;
      used.add(amount);
    }
  }

  if (known.content === undefined) {
    const content = bestColumn(free(), (i) => {
      const cells = cellsOf(rows, i);
      const isText = (c: string) => !isDate(c) && !isAmount(c);
      if (!mostly(cells, isText)) return undefined;
      return cells.reduce((sum, c) => sum + c.trim().length, 0) / cells.length;
    });
    if (content !== undefined) added.content = content;
  }
  return added;
}
