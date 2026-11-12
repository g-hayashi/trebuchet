import {
  type StatementColumnIndexes,
  StatementColumnMapping,
  type StatementDelimiter,
  type StatementTableLayout,
  YEN_LIMIT,
} from "@trebuchet/schema";
import { isValidDate } from "../dates.ts";
import { type DelimitedLine, parseDelimitedLines } from "../import/csv.ts";
import { domainError, err, ok, type Result } from "../types.ts";
import { suggestAmountSign, suggestColumns } from "./columns.ts";

/**
 * 明細の表（貼り付け・ファイル）の値の読み取り（007/R5・R6）。列の対応（`StatementColumnMapping`）で
 * 列の役割を決め、行ごとに日付・金額を読む。読めない行は理由つきで返し、明細には加えない
 */

/** 明細の 1 行 */
export type StatementRow = {
  accountName: string;
  /** YYYY-MM-DD */
  date: string;
  content: string;
  /** 符号つき（入金が正、出金が負） */
  amount: number;
  categoryMajor?: string | undefined;
  categoryMinor?: string | undefined;
  memo?: string | undefined;
  transferFlag: boolean;
  externalId?: string | undefined;
};

export type UnreadableRow = { line: number; reason: string };

export type StatementTable = { rows: StatementRow[]; unreadable: UnreadableRow[] };

export type StatementReadOptions = {
  /** 年のない日付（`MM/DD`）に使う年 */
  year: number;
  /** 1 つの口座の取込元の口座名。対応に `accountName` の役割がないときの全行の口座（INV-50） */
  fixedAccountName?: string | undefined;
};

const TRUE_VALUES = new Set(["1", "○", "◯", "true", "yes", "はい", "振替"]);

const norm = (s: string): string => s.normalize("NFKC").trim();

/**
 * 金額の書き方を読む（R5）。NFKC の後、`,`・`¥`・`円`・空白を除き、`−‐‑–—` を `-` にする。
 * 先頭の `△`・`▲` と全体の括弧 `(1,234)` は負。整数でなければ undefined（小数・外貨・空。括弧・△の中に符号があるときも）。
 * `|金額| >= 1e12` は "large"
 */
export function parseStatementAmount(raw: string): number | undefined | "large" {
  let s = norm(raw)
    .replace(/[−‐‑–—]/g, "-")
    .replace(/[,¥￥円\s]/g, "");
  let negative = false;
  const paren = /^\((.*)\)$/.exec(s);
  if (paren !== null) {
    s = paren[1] as string;
    negative = true;
  } else if (s.startsWith("△") || s.startsWith("▲")) {
    s = s.slice(1);
    negative = true;
  }
  // 括弧・△で負にしたときは、中に符号を許さない（`(-1,234)` や `△-1000` は符号が重なり反転するため読まない）
  if (!(negative ? /^\d+$/ : /^[+-]?\d+$/).test(s)) return undefined;
  const n = Number(s);
  if (Math.abs(n) >= YEN_LIMIT) return "large";
  const signed = negative ? -n : n;
  return signed === 0 ? 0 : signed;
}

/** 和暦の元号: 初日（YYYY-MM-DD）と、西暦にするための差（西暦 = 年 + offset） */
const ERAS = {
  令和: { start: "2019-05-01", end: "9999-12-31", offset: 2018 },
  平成: { start: "1989-01-08", end: "2019-04-30", offset: 1988 },
} as const;

const p2 = (n: string | number): string => String(n).padStart(2, "0");

/**
 * 日付の書き方を行ごとに読む（R6）: `YYYY/MM/DD`・`YYYY-MM-DD`・`YYYY.MM.DD`・`YYYY年M月D日`・`YYYYMMDD`・
 * `MM/DD`（`(曜)` つき可。年は引数）・和暦（`令和N年M月D日`・`R N.M.D`・`RN/M/D`、平成も同じ。`元年`）。
 * 時刻は日付の部分だけを読む。`YY/MM/DD`（2 桁の年は 2000 年代。R16）も読む。読めなければ undefined（`DD/MM/YYYY` は読まない）
 */
export function parseStatementDate(raw: string, year: number): string | undefined {
  const s = norm(raw)
    .replace(/(?:\s+|T)\d{1,2}:\d{2}(?::\d{2})?$/, "")
    .replace(/\s*\([^)]*\)$/, "")
    .trim();
  const ymd = (y: string | number, m: string, d: string): string =>
    `${String(y).padStart(4, "0")}-${p2(m)}-${p2(d)}`;
  const date = readDateParts(s, year, ymd);
  return date !== undefined && isValidDate(date) ? date : undefined;
}

function readDateParts(
  s: string,
  year: number,
  ymd: (y: string | number, m: string, d: string) => string,
): string | undefined {
  const full = /^(\d{4})(?:[/.-](\d{1,2})[/.-](\d{1,2})|年(\d{1,2})月(\d{1,2})日)$/.exec(s);
  if (full !== null) {
    return ymd(full[1] as string, (full[2] ?? full[4]) as string, (full[3] ?? full[5]) as string);
  }
  // 年が 2 桁の `YY/MM/DD`（カードの明細）は 2000 年代として読む（R16）。`DD/MM/YY` は読まない（`YY/MM/DD` と取り違える）
  const shortYear = /^(\d{2})[/.-](\d{1,2})[/.-](\d{1,2})$/.exec(s);
  if (shortYear !== null) {
    return ymd(2000 + Number(shortYear[1]), shortYear[2] as string, shortYear[3] as string);
  }
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (compact !== null)
    return ymd(compact[1] as string, compact[2] as string, compact[3] as string);
  const short = /^(\d{1,2})[/-](\d{1,2})$/.exec(s);
  if (short !== null) return ymd(year, short[1] as string, short[2] as string);
  const wareki =
    /^(令和|平成|R|H)\s*(\d{1,2}|元)(?:年|[./-])(\d{1,2})(?:月|[./-])(\d{1,2})日?$/i.exec(s);
  if (wareki !== null) {
    const era = ERAS[/^(令和|R)$/i.test(wareki[1] as string) ? "令和" : "平成"];
    const eraYear = wareki[2] === "元" ? 1 : Number(wareki[2]);
    const western = ymd(eraYear + era.offset, wareki[3] as string, wareki[4] as string);
    // 元号の範囲の外（令和 1 年 4 月 30 日 = 平成の最終日など）は読まない
    return western < era.start || western > era.end ? undefined : western;
  }
  return undefined;
}

/**
 * セルの最初の行（前後の空白を除く）。セルの中の改行でつながった金額（`5,000` と、割引後額の `(5,000)`）は、
 * 最初の行（割引前）を金額として読む（R16）
 */
export const firstLine = (cell: string): string => cell.trim().split(/[\r\n]+/)[0] ?? "";

const optional = (cell: string | undefined): string | undefined => {
  const s = cell?.trim();
  return s === undefined || s === "" ? undefined : s;
};

/** 読む行数（空でない行。前置き・見出しを含む）と列数の上限（R12） */
export const MAX_STATEMENT_ROWS = 20_000;
export const MAX_STATEMENT_COLUMNS = 50;

const SAMPLE_ROW_COUNT = 10;
/** 区切り文字の採点に使う、空でない先頭の行数（R2-1） */
const SCORE_ROW_COUNT = 50;
/** 見出しの行を探す、空でない先頭の行数（R2-2） */
const HEADER_SCAN_ROW_COUNT = 30;
/** 候補の順。採点が同点のときはこの順（R2-1） */
const DELIMITER_CANDIDATES: readonly StatementDelimiter[] = ["\t", ",", ";"];

/**
 * `detectTableLayout` の戻り。`StatementTableLayout`（data-model §3）のうち、文字コード（server の `decodeText` の結果）と
 * 取込元の照合（`match`・`headerDiff`。007/T012）を除いた部分
 */
export type StatementTableDetection = Omit<
  StatementTableLayout,
  "match" | "headerDiff" | "encoding"
>;

/** 利用者の選び直し。`delimiter` を指定すれば採点しない。`headerRow` を指定すれば見出しの判定をしない（null は見出しなし） */
export type StatementLayoutOverride = {
  delimiter?: StatementDelimiter | undefined;
  /** 元のテキストの行の番号（0 起点） */
  headerRow?: number | null | undefined;
};

/**
 * 件にまとめた行。`headerGroup` は、見出しのセルの中の改行でばらけた物理行をまとめた見出しの行、
 * `merged` は、複数の物理行をまとめた件（R16）
 */
type TableLine = DelimitedLine & { headerGroup?: true; merged?: true };

const nonEmptyLines = (text: string, delimiter: string): DelimitedLine[] =>
  parseDelimitedLines(text, delimiter).filter((l) => l.cells.some((c) => c.trim() !== ""));

/**
 * 表の行（空行を除く）。タブ区切りでは、セルの中の改行（ブラウザの表のコピー）でばらけた物理行を件にまとめる
 * （`foldCellNewlines`）。`detectTableLayout` と `readStatementTable` が同じ行を見るよう、どちらもここを通す（R16）
 */
const tableLines = (text: string, delimiter: string): TableLine[] => {
  const lines = nonEmptyLines(text, delimiter);
  return delimiter === "\t" ? foldCellNewlines(lines) : lines;
};

/**
 * 列数の最頻値（2 以上のうち。同数なら `tie` の方（既定は大きい方））。2 以上がなければ全体の最頻値。
 * `count` はその列数の数
 */
function modeOfWidths(
  widths: readonly number[],
  tie: "larger" | "smaller" = "larger",
): { width: number; count: number } {
  const tally = (minWidth: number): { width: number; count: number } => {
    const counts = new Map<number, number>();
    for (const w of widths) {
      if (w >= minWidth) counts.set(w, (counts.get(w) ?? 0) + 1);
    }
    let best = { width: 0, count: 0 };
    for (const [width, count] of counts) {
      const wins = tie === "larger" ? width > best.width : best.count === 0 || width < best.width;
      if (count > best.count || (count === best.count && wins)) {
        best = { width, count };
      }
    }
    return best;
  };
  const multi = tally(2);
  return multi.count > 0 ? multi : tally(1);
}

/**
 * 列数の最頻値（2 列以上の行のうち。同数なら大きい方）。2 列以上の行がなければ全行の最頻値。
 * 先頭 `SCORE_ROW_COUNT` 行で数える。`count` はその列数の行の数、`considered` は数えた行の数
 */
function modeWidth(lines: readonly TableLine[]): {
  width: number;
  count: number;
  considered: number;
} {
  const head = lines.slice(0, SCORE_ROW_COUNT);
  // まとめた見出し（headerGroup）は幅が広いことがあるので、最頻値には数えない（R16）
  const widths = head.filter((l) => l.headerGroup !== true).map((l) => l.cells.length);
  return { ...modeOfWidths(widths), considered: head.length };
}

/** 日付として読めるセルで始まる行か（件の始まり） */
const startsWithDate = (l: DelimitedLine): boolean => {
  const first = l.cells[0];
  return first !== undefined && parseStatementDate(first, 2000) !== undefined;
};

/** 2 つの行を、境のセル（前の行の最後と次の行の最初）を改行でつないで 1 行にする。空のセルはそのまま相手を残す */
function joinRows(a: readonly string[], b: readonly string[]): string[] {
  const last = a[a.length - 1] ?? "";
  const first = b[0] ?? "";
  const boundary = last.trim() === "" ? first : first.trim() === "" ? last : `${last}\n${first}`;
  return [...a.slice(0, -1), boundary, ...b.slice(1)];
}

/**
 * 年だけの行（`2026` の 1 セル）の直後に年なしの日付で始まる行が来たら、2 つを `2026/10/09` で始まる 1 行にする。
 * 行の番号は年の行（件の最初の物理行）
 */
function joinYearLines(lines: readonly DelimitedLine[]): TableLine[] {
  const out: TableLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] as DelimitedLine;
    const next = lines[i + 1];
    const year = l.cells.length === 1 ? /^\d{4}$/.exec(norm(l.cells[0] as string)) : null;
    const nextFirst = next?.cells[0];
    if (year !== null && next !== undefined && nextFirst !== undefined && isYearless(nextFirst)) {
      const date = `${year[0]}/${nextFirst.trim().replace(/^(\d{1,2})-(\d{1,2})/, "$1/$2")}`;
      out.push({ line: l.line, cells: [date, ...next.cells.slice(1)], merged: true });
      i++;
    } else {
      out.push(l);
    }
  }
  return out;
}

/**
 * セルの中の改行を復元する（タブ区切り。R16）。ブラウザの表をコピーすると、セルの中の改行（`<br>`）が引用符なしの
 * 改行になり、1 件・見出しが複数の物理行に分かれる。
 * 1. 年だけの行と、その次の年なしの日付の行を 1 行にする（`joinYearLines`）
 * 2. 最初の件より前の行（2 行以上）は、どの行も件の列数の最頻値を持たず（年の行がなければ、日付の行そのものの幅も持たず）、
 *    まとめた行が見出しの辞書に日付として当たるときだけ、見出しの 1 行にまとめる（`headerGroup`）。それより前の行は前置き
 * 3. 日付として読めるセルで始まる行を件の始まりとし、始まりでない行は前の件に続ける（境のセルを改行でつなぐ）。
 *    ただし、件がすでに最頻値に達している、またはつなぐと最頻値を超える行は、つながず独立した行のまま
 *    （合計の行や、日付のない行が金額を壊さない）。最頻値は、始まりでない行をすべて続けたと仮定した件の列数で数える
 *    （同数なら小さい方。合計の行が 1 件だけを広げても、その幅にならない）。
 *    件のまとめは、セルの中の改行の証拠（2 の見出し、1 の年の行）があるときだけ行う。日付で始まる 1 行 1 件の表で、
 *    日付のない行（合計など）を前の件に続けて壊さないため
 * 行の番号は件・見出しの最初の物理行。日付で始まる行がなければ何もしない（MF ME の貼り付けなど）
 */
function foldCellNewlines(lines: readonly DelimitedLine[]): TableLine[] {
  const joined = joinYearLines(lines);
  const firstStart = joined.findIndex(startsWithDate);
  if (firstStart < 0) return joined;

  const widths: number[] = [];
  for (const l of joined.slice(firstStart)) {
    if (startsWithDate(l)) widths.push(l.cells.length);
    else widths[widths.length - 1] = (widths[widths.length - 1] as number) + l.cells.length - 1;
  }
  const { width: mode, count } = modeOfWidths(widths.slice(0, SCORE_ROW_COUNT), "smaller");
  const yearJoined = joined.some((l) => l.merged === true);
  // 最頻値の幅の件が 1 つしかない（日付のない行の分だけ広がった 1 件かもしれない）なら、年の行の証拠がない限りまとめない
  if (count < 2 && !yearJoined) return joined;

  const preface = joined.slice(0, firstStart);
  let folded: TableLine[] = preface;
  let evidence = yearJoined;
  // 年の行の証拠がなければ、日付の行そのものと同じ幅の行（1 行の見出し・前置き・合計の行）がある表は、1 行 1 件とみなす
  const physical = modeOfWidths(
    joined
      .slice(firstStart)
      .filter(startsWithDate)
      .map((l) => l.cells.length)
      .slice(0, SCORE_ROW_COUNT),
    "smaller",
  ).width;
  const blocksHeader = (l: DelimitedLine): boolean =>
    l.cells.length === mode || (!yearJoined && l.cells.length === physical);
  if (preface.length >= 2 && !preface.some(blocksHeader)) {
    for (let k = 0; k <= preface.length - 2; k++) {
      const group = preface.slice(k);
      const cells = group.reduce<string[]>(
        (acc, l, i) => (i === 0 ? [...l.cells] : joinRows(acc, l.cells)),
        [],
      );
      if (suggestColumns(cells).date !== undefined) {
        const head: TableLine = {
          line: (group[0] as DelimitedLine).line,
          cells,
          headerGroup: true,
        };
        folded = [...preface.slice(0, k), head];
        evidence = true;
        break;
      }
    }
  }
  if (!evidence) return joined;

  const items: TableLine[] = [];
  let item: TableLine | undefined;
  for (const l of joined.slice(firstStart)) {
    if (startsWithDate(l)) {
      item = { ...l };
      items.push(item);
    } else if (
      item !== undefined &&
      item.cells.length < mode &&
      item.cells.length + l.cells.length - 1 <= mode
    ) {
      item.cells = joinRows(item.cells, l.cells);
      item.merged = true;
    } else {
      items.push(l);
    }
  }
  return [...folded, ...items];
}

/** 日付・金額として読めるセルか（年のない日付も含む） */
const looksLikeValue = (cell: string): boolean =>
  parseStatementDate(cell, 2000) !== undefined || parseStatementAmount(cell) !== undefined;

/**
 * 見出しの行の番号（`lines` の中の位置）。最頻値の列数を持つ先頭 30 行のうち、
 * ①セルが辞書に 1 つでも当たる最初の行、なければ ②すべてのセルが空でなく日付・金額として読めず、
 * 次の行に日付として読めるセルがある最初の行。どちらもなければ null（R2-2）
 */
function findHeaderIndex(lines: readonly TableLine[], width: number): number | null {
  const scan = lines.slice(0, HEADER_SCAN_ROW_COUNT);
  for (const [i, l] of scan.entries()) {
    // まとめた見出し（headerGroup）は、外貨の列などで件の最頻値より幅が広くてもよい（R16）
    const fits = l.cells.length === width || l.headerGroup === true;
    if (fits && Object.keys(suggestColumns(l.cells)).length > 0) return i;
  }
  for (const [i, l] of scan.entries()) {
    if (l.cells.length !== width) continue;
    if (!l.cells.every((c) => c.trim() !== "" && !looksLikeValue(c))) continue;
    const next = lines[i + 1];
    if (next?.cells.some((c) => parseStatementDate(c, 2000) !== undefined)) return i;
  }
  return null;
}

/** 年のない書き方（`MM/DD`）か。年を変えると結果が変わる日付。うるう年どうしで比べる（02/29 を読めるように） */
const isYearless = (cell: string): boolean => {
  const a = parseStatementDate(cell, 2000);
  const b = parseStatementDate(cell, 2004);
  return a !== undefined && b !== undefined && a !== b;
};

/** データの行に、年のない日付が 1 つでもあるか。日付の列の案があればその列だけ、なければ全列を見る（R6） */
function hasYearlessDate(
  dataLines: readonly DelimitedLine[],
  suggested: StatementColumnIndexes,
): boolean {
  const column = suggested.date;
  return dataLines.some((l) =>
    column === undefined
      ? l.cells.some(isYearless)
      : l.cells[column] !== undefined && isYearless(l.cells[column] as string),
  );
}

/**
 * 区切り文字の候補の採点（R2-1）: 空でない先頭 50 行のうち、2 列以上の行の列数の最頻値を持つ行の割合。
 * セルの中の改行をまとめた表（`merged`・`headerGroup` の行がある）では、外貨の列などで最頻値より広い行も数える
 * （桁区切りのカンマで割れた別の候補に、最頻値の行の割合だけで負けないため。R16）
 */
function delimiterScore(lines: readonly TableLine[]): number {
  const { width, count, considered } = modeWidth(lines);
  if (width < 2) return 0;
  const folded = lines.some((l) => l.headerGroup === true || l.merged === true);
  const matching = folded
    ? lines.slice(0, SCORE_ROW_COUNT).filter((l) => l.cells.length >= width).length
    : count;
  return matching / considered;
}

/**
 * 表のテキストの区切り文字と見出しの行を判定する（007/R2）。値は読まない（日付・金額の読み取りは `readStatementTable`）。
 * 1. 区切り文字: タブ・カンマ・セミコロンの候補ごとに引用つきで分割し、空でない先頭 50 行のうち、2 列以上の行の列数の最頻値を持つ行の割合で採点する
 *    （同点はタブ → カンマ → セミコロン）。どの候補も 2 列以上の行がなければ、タブで返す（利用者が選び直せる）
 * 2. 見出しの行: `findHeaderIndex`。見出しより前の行は前置きで、読まない・返さない（FR-017）。見出しなしなら、
 *    最頻値の列数を持つ最初の行より前が前置き（見本・行数に入れない）
 * - `override.delimiter` があれば採点しない。`override.headerRow` があれば見出しの判定をしない（その行がテキストにない・空なら
 *   `STATEMENT_TABLE_UNREADABLE`）
 * - `suggestedColumns` は見出しの案（辞書。R4）。見出しなしなら空。`sampleRows` は見出しより後の先頭 10 行
 * - 失敗: 空でない行がなければ `STATEMENT_TABLE_UNREADABLE`、20,000 行・50 列を超えれば `STATEMENT_TABLE_TOO_LARGE`（R12）
 */
export function detectTableLayout(
  text: string,
  override?: StatementLayoutOverride,
): Result<StatementTableDetection> {
  let delimiter: StatementDelimiter;
  let lines: TableLine[];
  if (override?.delimiter !== undefined) {
    delimiter = override.delimiter;
    lines = tableLines(text, delimiter);
  } else {
    let best: { delimiter: StatementDelimiter; lines: TableLine[]; score: number } | undefined;
    for (const candidate of DELIMITER_CANDIDATES) {
      const candidateLines = tableLines(text, candidate);
      const score = delimiterScore(candidateLines);
      if (best === undefined || score > best.score) {
        best = { delimiter: candidate, lines: candidateLines, score };
      }
    }
    // best は候補が 1 つ以上あるので必ず入る
    ({ delimiter, lines } = best as NonNullable<typeof best>);
  }

  if (lines.length === 0) {
    return err(domainError("STATEMENT_TABLE_UNREADABLE", "読める行がありません"));
  }
  const widest = lines.reduce((max, l) => Math.max(max, l.cells.length), 0);
  if (lines.length > MAX_STATEMENT_ROWS || widest > MAX_STATEMENT_COLUMNS) {
    return err(
      domainError(
        "STATEMENT_TABLE_TOO_LARGE",
        `表が大きすぎます（${MAX_STATEMENT_ROWS} 行・${MAX_STATEMENT_COLUMNS} 列まで）`,
        { maxRows: MAX_STATEMENT_ROWS, maxColumns: MAX_STATEMENT_COLUMNS },
      ),
    );
  }

  const { width } = modeWidth(lines);
  let headerIndex: number | null;
  if (override?.headerRow === undefined) {
    headerIndex = findHeaderIndex(lines, width);
  } else if (override.headerRow === null) {
    headerIndex = null;
  } else {
    const row = override.headerRow;
    const found = lines.findIndex((l) => l.line - 1 === row);
    if (found < 0) {
      return err(
        domainError("STATEMENT_TABLE_UNREADABLE", "指定した見出しの行がありません", {
          headerRow: row,
        }),
      );
    }
    headerIndex = found;
  }

  const headerLine = headerIndex === null ? undefined : lines[headerIndex];
  const header = headerLine === undefined ? null : headerLine.cells;
  // 見出しなしでは、最頻値の列数を持つ最初の行より前が前置き（R2-3）。見本・行数・年の判定に入れない
  const dataLines =
    headerIndex === null
      ? lines.slice(
          Math.max(
            0,
            lines.findIndex((l) => l.cells.length === width),
          ),
        )
      : lines.slice(headerIndex + 1);
  // まとめた見出しが件の最頻値より広いとき、表の列数の外の列は案にしない（画面に出ない列を案にしない）
  const suggestedColumns: StatementColumnIndexes =
    header === null
      ? {}
      : (Object.fromEntries(
          Object.entries(suggestColumns(header)).filter(([, index]) => index < width),
        ) as StatementColumnIndexes);
  const suggestedAmountSign = suggestAmountSign(header, suggestedColumns.amount);
  return ok({
    delimiter,
    headerRow: headerLine === undefined ? null : headerLine.line - 1,
    header,
    columnCount: width,
    rowCount: dataLines.length,
    sampleRows: dataLines.slice(0, SAMPLE_ROW_COUNT).map((l) => l.cells),
    needsYear: hasYearlessDate(dataLines, suggestedColumns),
    suggestedColumns,
    ...(suggestedAmountSign === undefined ? {} : { suggestedAmountSign }),
  });
}

const invalid = (message: string, details?: Record<string, unknown>) =>
  err(domainError("STATEMENT_MAPPING_INVALID", message, details));

/**
 * 表のテキストを、列の対応で明細の行にする。
 * - `mapping.headerRow` は元のテキストの行の番号（0 起点）。それより前の行（前置き）は読まない。null なら全行がデータ
 * - 金額 1 列: `amountSign` が `outflow_positive` なら符号を反転する。出金・入金の 2 列: どちらかに 0 でない値がある行だけを読み、
 *   出金の値 v は金額 −v、入金の値 v は +v（出金の列の負の値は入金になる）
 * - 口座: `accountName` の列があればその値、なければ全行が `fixedAccountName`（INV-50）
 * - 読めない行は `{ line（元のテキストの行の番号、1 起点）, reason }` で返す。空行は数えない
 * - 失敗: 対応が不正（列の番号が表の列数を超える、口座名の出どころがない）なら `STATEMENT_MAPPING_INVALID`、
 *   1 行も読めなければ `STATEMENT_TABLE_UNREADABLE`（`details.unreadable`）
 */
export function readStatementTable(
  text: string,
  mapping: StatementColumnMapping,
  options: StatementReadOptions,
): Result<StatementTable> {
  const parsedMapping = StatementColumnMapping.safeParse(mapping);
  if (!parsedMapping.success) {
    return invalid("列の対応が正しくありません", {
      issues: parsedMapping.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
  const c = mapping.columns;
  const fixedAccountName = optional(options.fixedAccountName);
  if (c.accountName === undefined && fixedAccountName === undefined) {
    return invalid("口座名の列がないときは、取込元の口座を指定してください");
  }

  const headerRow = mapping.headerRow;
  const lines = tableLines(text, mapping.delimiter).filter(
    (l) => headerRow === null || l.line - 1 >= headerRow,
  );
  const dataLines = headerRow === null ? lines : lines.filter((l) => l.line - 1 > headerRow);

  // 対応の列の番号は、表の列数（見出しとデータの行の最大の幅）の中になければならない
  const columnCount = lines.reduce((max, l) => Math.max(max, l.cells.length), 0);
  const used = Object.values(c);
  const beyond = used.filter((i) => i >= columnCount);
  if (columnCount > 0 && beyond.length > 0) {
    return invalid("列の番号が表の列数を超えています", { columnCount, columns: beyond });
  }

  // 必須の列（日付・内容・金額か出金と入金・口座名）が行になければ「列が足りません」
  const required = [c.date, c.content, c.amount, c.outflow, c.inflow, c.accountName].filter(
    (i): i is number => i !== undefined,
  );
  const requiredWidth = Math.max(...required) + 1;
  const split = c.outflow !== undefined && c.inflow !== undefined;

  const rows: StatementRow[] = [];
  const unreadable: UnreadableRow[] = [];
  for (const { line, cells } of dataLines) {
    const cell = (index: number | undefined): string | undefined =>
      index === undefined ? undefined : cells[index];
    const reject = (reason: string) => unreadable.push({ line, reason });

    if (cells.length < requiredWidth) {
      reject("列が足りません");
      continue;
    }
    const date = parseStatementDate(cell(c.date) ?? "", options.year);
    if (date === undefined) {
      reject("日付を読めません");
      continue;
    }
    const content = (cell(c.content) ?? "").trim();
    if (content === "") {
      reject("内容が空です");
      continue;
    }
    let accountName = fixedAccountName;
    if (c.accountName !== undefined) {
      accountName = optional(cell(c.accountName));
      if (accountName === undefined) {
        reject("口座名が空です");
        continue;
      }
    }

    const amount = split
      ? readSplitAmount(cell(c.outflow) ?? "", cell(c.inflow) ?? "")
      : readSingleAmount(cell(c.amount) ?? "", mapping.amountSign);
    if (typeof amount === "string") {
      reject(amount);
      continue;
    }

    const row: StatementRow = {
      accountName: accountName as string,
      date,
      content,
      amount: amount.value,
      transferFlag: TRUE_VALUES.has(norm(cell(c.transferFlag) ?? "").toLowerCase()),
    };
    const categoryMajor = optional(cell(c.categoryMajor));
    const categoryMinor = optional(cell(c.categoryMinor));
    const memo = optional(cell(c.memo));
    const externalId = optional(cell(c.externalId));
    if (categoryMajor !== undefined) row.categoryMajor = categoryMajor;
    if (categoryMinor !== undefined) row.categoryMinor = categoryMinor;
    if (memo !== undefined) row.memo = memo;
    if (externalId !== undefined) row.externalId = externalId;
    rows.push(row);
  }

  if (rows.length === 0) {
    return err(domainError("STATEMENT_TABLE_UNREADABLE", "読める行がありません", { unreadable }));
  }
  return ok({ rows, unreadable });
}

/** 金額のセル 1 つ: 値（0 は値なし = null）か、読めない理由 */
function readCell(raw: string): { value: number | null } | string {
  if (raw.trim() === "") return { value: null };
  const n = parseStatementAmount(firstLine(raw));
  if (n === undefined) return "金額を読めません";
  if (n === "large") return "金額が大きすぎます";
  return { value: n === 0 ? null : n };
}

/** 金額 1 列。空は「金額が空です」。0 は 0 円の明細として読む（006 の Edge Cases） */
function readSingleAmount(
  raw: string,
  sign: StatementColumnMapping["amountSign"],
): { value: number } | string {
  if (raw.trim() === "") return "金額が空です";
  const cell = readCell(raw);
  if (typeof cell === "string") return cell;
  const value = cell.value ?? 0;
  return { value: sign === "outflow_positive" && value !== 0 ? -value : value };
}

/** 出金・入金の 2 列。出金の値 v は −v、入金の値 v は +v */
function readSplitAmount(outflowRaw: string, inflowRaw: string): { value: number } | string {
  const outflow = readCell(outflowRaw);
  if (typeof outflow === "string") return outflow;
  const inflow = readCell(inflowRaw);
  if (typeof inflow === "string") return inflow;
  if (outflow.value !== null && inflow.value !== null) return "出金と入金の両方に値があります";
  if (outflow.value !== null) return { value: -outflow.value };
  if (inflow.value !== null) return { value: inflow.value };
  return "金額が空です";
}
