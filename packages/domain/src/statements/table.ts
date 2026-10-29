import {
  type StatementColumnIndexes,
  StatementColumnMapping,
  type StatementDelimiter,
  type StatementTableLayout,
} from "@trebuchet/schema";
import { isValidDate } from "../dates.ts";
import { type DelimitedLine, parseDelimitedLines } from "../import/csv.ts";
import { domainError, err, ok, type Result } from "../types.ts";
import { suggestColumns } from "./columns.ts";

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

const MAX_AMOUNT = 1_000_000_000_000;
const TRUE_VALUES = new Set(["1", "○", "◯", "true", "yes", "はい", "振替"]);

const norm = (s: string): string => s.normalize("NFKC").trim();

/**
 * 金額の書き方を読む（R5）。NFKC の後、`,`・`¥`・`円`・空白を除き、`−‐‑–—` を `-` にする。
 * 先頭の `△`・`▲` と全体の括弧 `(1,234)` は負。整数でなければ undefined（小数・外貨・空）。
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
  if (!/^[+-]?\d+$/.test(s)) return undefined;
  const n = Number(s);
  if (Math.abs(n) >= MAX_AMOUNT) return "large";
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
 * 時刻は日付の部分だけを読む。読めなければ undefined（`DD/MM/YYYY` は読まない）
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
 * 取込元の照合（`match`・`headerDiff`。T012）を除いた部分
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

const nonEmptyLines = (text: string, delimiter: string): DelimitedLine[] =>
  parseDelimitedLines(text, delimiter).filter((l) => l.cells.some((c) => c.trim() !== ""));

/**
 * 列数の最頻値（2 列以上の行のうち。同数なら大きい方）。2 列以上の行がなければ全行の最頻値。
 * 先頭 `SCORE_ROW_COUNT` 行で数える。`count` はその列数の行の数、`considered` は数えた行の数
 */
function modeWidth(lines: readonly DelimitedLine[]): {
  width: number;
  count: number;
  considered: number;
} {
  const head = lines.slice(0, SCORE_ROW_COUNT);
  const tally = (minWidth: number): { width: number; count: number } => {
    const counts = new Map<number, number>();
    for (const l of head) {
      if (l.cells.length >= minWidth)
        counts.set(l.cells.length, (counts.get(l.cells.length) ?? 0) + 1);
    }
    let best = { width: 0, count: 0 };
    for (const [width, count] of counts) {
      if (count > best.count || (count === best.count && width > best.width)) {
        best = { width, count };
      }
    }
    return best;
  };
  const multi = tally(2);
  return { ...(multi.count > 0 ? multi : tally(1)), considered: head.length };
}

/** 日付・金額として読めるセルか（年のない日付も含む） */
const looksLikeValue = (cell: string): boolean =>
  parseStatementDate(cell, 2000) !== undefined || parseStatementAmount(cell) !== undefined;

/**
 * 見出しの行の番号（`lines` の中の位置）。最頻値の列数を持つ先頭 30 行のうち、
 * ①セルが辞書に 1 つでも当たる最初の行、なければ ②すべてのセルが空でなく日付・金額として読めず、
 * 次の行に日付として読めるセルがある最初の行。どちらもなければ null（R2-2）
 */
function findHeaderIndex(lines: readonly DelimitedLine[], width: number): number | null {
  const scan = lines.slice(0, HEADER_SCAN_ROW_COUNT);
  for (const [i, l] of scan.entries()) {
    if (l.cells.length === width && Object.keys(suggestColumns(l.cells)).length > 0) return i;
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
  let lines: DelimitedLine[];
  if (override?.delimiter !== undefined) {
    delimiter = override.delimiter;
    lines = nonEmptyLines(text, delimiter);
  } else {
    let best: { delimiter: StatementDelimiter; lines: DelimitedLine[]; score: number } | undefined;
    for (const candidate of DELIMITER_CANDIDATES) {
      const candidateLines = nonEmptyLines(text, candidate);
      const { width, count, considered } = modeWidth(candidateLines);
      const score = width >= 2 ? count / considered : 0;
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
  const suggestedColumns = header === null ? {} : suggestColumns(header);
  return ok({
    delimiter,
    headerRow: headerLine === undefined ? null : headerLine.line - 1,
    header,
    columnCount: width,
    rowCount: dataLines.length,
    sampleRows: dataLines.slice(0, SAMPLE_ROW_COUNT).map((l) => l.cells),
    needsYear: hasYearlessDate(dataLines, suggestedColumns),
    suggestedColumns,
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
  const lines = parseDelimitedLines(text, mapping.delimiter).filter(
    (l) => (headerRow === null || l.line - 1 >= headerRow) && l.cells.some((x) => x.trim() !== ""),
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
  const n = parseStatementAmount(raw);
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
