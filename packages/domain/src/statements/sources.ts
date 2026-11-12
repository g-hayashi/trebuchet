import type {
  StatementColumnIndexes,
  StatementColumnMapping,
  StatementColumnRole,
  StatementSource,
  StatementTableLayout,
} from "@trebuchet/schema";
import { compareText } from "../text.ts";
import { normalizeHeaderName } from "./columns.ts";

// 取込元の照合（007/R7・R8）。純関数

/** 照合に使う、今回の判定（`detectTableLayout` の戻り）の部分 */
export type LayoutForMatch = {
  header: string[] | null;
  headerRow: number | null;
  columnCount: number;
};

export type StatementSourceMatch = StatementTableLayout["match"];

/** 見出しの署名: 見出しのセルの名前を `normalizeHeaderName` で正規化した配列。見出しなしは null */
export function headerSignature(header: string[] | null): string[] | null {
  return header === null ? null : header.map(normalizeHeaderName);
}

const sameSignature = (a: string[] | null, b: string[] | null): boolean =>
  a !== null && b !== null && a.length === b.length && a.every((name, i) => name === b[i]);

/**
 * 取込元の対応を、今回の判定の表に当てはめた形にする。見出しの行は今回の判定の行にする
 * （前置きの行数は月ごとに変わりうるので、保存した `headerRow` は使わない。R8）。
 * 区切り文字・列の役割・符号の向きは保存した値のまま
 */
export function applySourceToLayout(
  source: StatementSource,
  layout: Pick<LayoutForMatch, "headerRow">,
): StatementSource {
  return { ...source, mapping: { ...source.mapping, headerRow: layout.headerRow } };
}

const newestFirst = (a: StatementSource, b: StatementSource): number =>
  compareText(b.lastUsedAt, a.lastUsedAt) || compareText(a.name, b.name) || (a.id < b.id ? -1 : 1);

/**
 * 見出しの署名が今回の見出しと完全一致する取込元を探す（R8）。0 件は `none`、1 件は `one`、2 件以上は
 * `many`（`last_used_at` の新しい順）。返す取込元の対応は `applySourceToLayout` で当てはめた形。
 * 見出しなしの表、見出しなしの取込元は、署名で探せないので当たらない
 */
export function matchStatementSources(
  layout: LayoutForMatch,
  sources: readonly StatementSource[],
): StatementSourceMatch {
  const signature = headerSignature(layout.header);
  const found = sources
    .filter((s) => sameSignature(s.header, signature))
    .sort(newestFirst)
    .map((s) => applySourceToLayout(s, layout));
  if (found.length === 0) return { kind: "none" };
  if (found.length === 1) return { kind: "one", source: found[0] as StatementSource };
  return { kind: "many", sources: found };
}

const maxColumnIndex = (mapping: StatementColumnMapping): number =>
  Math.max(...Object.values(mapping.columns));

/**
 * 利用者が手で選んだ取込元が、今回の表に当てはまるか。見出しがある取込元は署名が一致するとき。
 * 見出しのない取込元は、今回の表にも見出しがなく、対応の列がすべて表の列に収まるときだけ
 * （取込元は列数を持たないので、列数の一致はこの形で確かめる）
 */
export function sourceFitsLayout(source: StatementSource, layout: LayoutForMatch): boolean {
  if (source.header !== null) return sameSignature(source.header, headerSignature(layout.header));
  return layout.header === null && layout.columnCount > maxColumnIndex(source.mapping);
}

/**
 * 保存した見出しと今回の見出しの違い。同じ名前は、出てくる順に 1 対 1 で対応づける。
 * `added` は今回だけにある列の名前（今回の見出しのまま）、`removed` は保存した見出しだけにある列の名前（署名のまま）。
 * `matched[i]` は今回の i 列目に対応する保存した列の番号（なければ undefined）
 */
export function diffHeader(
  sourceSignature: readonly string[],
  header: readonly string[] | null,
): { added: string[]; removed: string[]; matched: (number | undefined)[] } {
  const current = header ?? [];
  const taken = new Set<number>();
  const matched = current.map((cell) => {
    const name = normalizeHeaderName(cell);
    const index = sourceSignature.findIndex((s, i) => !taken.has(i) && s === name);
    if (index < 0) return undefined;
    taken.add(index);
    return index;
  });
  return {
    added: current.filter((_, i) => matched[i] === undefined),
    removed: sourceSignature.filter((_, i) => !taken.has(i)),
    matched,
  };
}

/**
 * 見出しが違う取込元の対応から、名前が同じ列の役割を引き継いだ案を作る（FR-011）。引き継げない役割は案に入れない。
 * 辞書の案（`dictionary`）は、引き継いだ役割と同じ列・同じ役割を使わない範囲で足す
 */
export function inheritColumns(
  source: StatementSource,
  header: readonly string[] | null,
  dictionary: StatementColumnIndexes,
): StatementColumnIndexes {
  const roleOfSourceColumn = new Map<number, StatementColumnRole>(
    (Object.entries(source.mapping.columns) as [StatementColumnRole, number][]).map(
      ([role, index]) => [index, role],
    ),
  );
  const result: StatementColumnIndexes = {};
  const { matched } = diffHeader(source.header ?? [], header);
  for (const [column, sourceIndex] of matched.entries()) {
    const role = sourceIndex === undefined ? undefined : roleOfSourceColumn.get(sourceIndex);
    if (role !== undefined) result[role] = column;
  }
  const usedColumns = new Set(Object.values(result));
  for (const [role, column] of Object.entries(dictionary) as [StatementColumnRole, number][]) {
    if (result[role] === undefined && !usedColumns.has(column)) {
      result[role] = column;
      usedColumns.add(column);
    }
  }
  return result;
}
