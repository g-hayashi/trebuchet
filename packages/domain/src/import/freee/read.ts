import { isValidDate } from "../../dates.ts";
import type { Result, Side } from "../../types.ts";
import { decodeText, parseCsv, type TextEncodingName } from "../csv.ts";
import {
  JOURNAL_COLUMN_NAMES,
  JOURNAL_COLUMNS,
  LEDGER_COLUMN_NAMES,
  LEDGER_COLUMNS,
} from "./columns.ts";

export type FreeeFileKind = "journal" | "ledger";

/** freee の書き出しを読んだ結果（data-model §3）。行は列名 → 値。値は元の文字のまま */
export type FreeeFile = {
  kind: FreeeFileKind;
  encoding: TextEncodingName;
  header: string[];
  rows: Record<string, string>[];
};

export type FreeeFileError = { code: "IMPORT_UNKNOWN_FORMAT"; missingColumns: string[] };

/** ヘッダを探す範囲（元帳は1行目がタイトルで、ヘッダは2行目） */
const HEADER_SEARCH_ROWS = 5;

const REQUIRED: readonly { kind: FreeeFileKind; columns: readonly string[] }[] = [
  { kind: "journal", columns: JOURNAL_COLUMN_NAMES },
  { kind: "ledger", columns: LEDGER_COLUMN_NAMES },
];

/**
 * 名前の照合のための正規化（research R4）: NFKC と前後の空白の除去。
 * 全角の英数字・空白は半角に、「㈱」は「(株)」になる。照合にだけ使い、保存する値は元の文字のまま
 */
export function normalizeName(s: string): string {
  return s.normalize("NFKC").trim();
}

/**
 * freee の仕訳帳・総勘定元帳のバイト列を読み、種類を判別する（FR-001, research R1, R3）。
 * 先頭5行の中で、取込に必要な列（columns.ts）をすべて含む行をヘッダとし、その列の組で種類を決める。
 * 列は位置ではなく列名で特定するため、列の順は問わない。ヘッダより前の行（元帳のタイトル）と空の行は捨てる。
 * どちらにも当たらなければ IMPORT_UNKNOWN_FORMAT で、最も近い種類の欠けている列名を返す
 */
export function readFreeeFile(bytes: Uint8Array): Result<FreeeFile, FreeeFileError> {
  const { text, encoding } = decodeText(bytes);
  const rows = parseCsv(text);

  let closest: { missing: string[]; ratio: number } | undefined;
  for (const [index, row] of rows.slice(0, HEADER_SEARCH_ROWS).entries()) {
    const header = row.map((cell) => cell.trim());
    const present = new Set(header);
    for (const { kind, columns } of REQUIRED) {
      const missing = columns.filter((c) => !present.has(c));
      if (missing.length === 0) {
        return {
          ok: true,
          value: { kind, encoding, header, rows: toRecords(header, rows.slice(index + 1)) },
        };
      }
      const ratio = 1 - missing.length / columns.length;
      if (closest === undefined || ratio > closest.ratio) closest = { missing, ratio };
    }
  }
  return {
    ok: false,
    error: {
      code: "IMPORT_UNKNOWN_FORMAT",
      missingColumns: closest?.missing ?? [...JOURNAL_COLUMN_NAMES],
    },
  };
}

function toRecords(header: readonly string[], data: readonly string[][]): Record<string, string>[] {
  const records: Record<string, string>[] = [];
  for (const row of data) {
    if (row.every((cell) => cell === "")) continue;
    const record: Record<string, string> = {};
    header.forEach((name, i) => {
      // 同じ列名が2つあれば、先の列を使う
      if (!Object.hasOwn(record, name)) record[name] = row[i] ?? "";
    });
    records.push(record);
  }
  return records;
}

// ---- 仕訳帳の仕訳（research R4） ----

/** freee の仕訳の1行（借方または貸方の一方）。名前は normalizeName 済み、摘要は元の文字のまま */
export type FreeeJournalLine = {
  side: Side;
  accountName: string;
  subAccountName?: string | undefined;
  amount: number;
  taxName: string;
  taxAmount: number;
  partnerName?: string | undefined;
  /** メモタグ。区切り文字はなく、列の値全体を1つのタグとする（002/T005） */
  tagNames: string[];
  description: string;
};

/** freee の仕訳（仕訳ID でまとめたもの） */
export type FreeeJournal = {
  freeeJournalId: string;
  freeeJournalNo: string | null;
  /** YYYY-MM-DD */
  date: string;
  /** 決算整理仕訳 = 1 */
  adjustment: boolean;
  /** 登録した方法 */
  entryMethod: string;
  /** 借方・貸方の備考（元の文字のまま、重複を除いて改行でつなぐ） */
  memo?: string | undefined;
  /** 仕訳行番号の順に、各行の借方 → 貸方 */
  lines: FreeeJournalLine[];
};

export type FreeeGroupRejectCode = "MISSING_FIELD" | "LINE_COUNT_MISMATCH" | "INVALID_AMOUNT";

/** まとめる段階で取込不可になった仕訳。date は読めれば YYYY-MM-DD、読めなければ元の文字 */
export type RejectedFreeeJournal = {
  freeeJournalId: string;
  freeeJournalNo: string | null;
  date: string;
  adjustment: boolean;
  code: FreeeGroupRejectCode;
};

export type GroupedFreeeJournals = {
  journals: FreeeJournal[];
  rejected: RejectedFreeeJournal[];
};

const C = JOURNAL_COLUMNS;
const DATE_PATTERN = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/;
const INTEGER_PATTERN = /^\d+$/;

/** YYYY/MM/DD・YYYY-M-D を YYYY-MM-DD にする。存在しない日付は undefined */
function parseFreeeDate(value: string): string | undefined {
  const m = DATE_PATTERN.exec(value.trim());
  if (m === null) return undefined;
  const date = `${m[1]}-${m[2]?.padStart(2, "0")}-${m[3]?.padStart(2, "0")}`;
  return isValidDate(date) ? date : undefined;
}

/** 0 以上の整数。空・小数・マイナス・数字以外は undefined */
function parseNonNegativeInt(value: string): number | undefined {
  const v = value.trim();
  if (!INTEGER_PATTERN.test(v)) return undefined;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : undefined;
}

const optionalName = (value: string | undefined): string | undefined => {
  const name = normalizeName(value ?? "");
  return name === "" ? undefined : name;
};

type LineResult = { ok: true; line: FreeeJournalLine } | { ok: false; code: FreeeGroupRejectCode };

function readSide(
  row: Record<string, string>,
  side: Side,
  description: string,
): LineResult | undefined {
  const cols = C[side];
  const accountName = normalizeName(row[cols.account] ?? "");
  if (accountName === "") return undefined;
  const amount = parseNonNegativeInt(row[cols.amount] ?? "");
  if (amount === undefined || amount === 0) return { ok: false, code: "INVALID_AMOUNT" };
  const taxAmountText = (row[cols.taxAmount] ?? "").trim();
  const taxAmount = taxAmountText === "" ? 0 : parseNonNegativeInt(taxAmountText);
  if (taxAmount === undefined) return { ok: false, code: "INVALID_AMOUNT" };
  const taxName = normalizeName(row[cols.taxCategory] ?? "");
  if (taxName === "") return { ok: false, code: "MISSING_FIELD" };
  const tag = optionalName(row[cols.memo]);
  return {
    ok: true,
    line: {
      side,
      accountName,
      subAccountName: optionalName(row[cols.subAccount]),
      amount,
      taxName,
      taxAmount,
      partnerName: optionalName(row[cols.partner]),
      tagNames: tag === undefined ? [] : [tag],
      description,
    },
  };
}

/** 取込不可の理由の優先順（複数あれば先のもの） */
const REJECT_ORDER: readonly FreeeGroupRejectCode[] = [
  "MISSING_FIELD",
  "LINE_COUNT_MISMATCH",
  "INVALID_AMOUNT",
];

/**
 * 仕訳帳の行を仕訳ID でまとめ、freee の仕訳にする（FR-002, research R4）。
 * 仕訳は初出の順、行は仕訳行番号の順で、各行を借方 → 貸方の順に仕訳行にする。勘定科目が空の側は行にしない。
 * 欠けた値・行数の不一致・不正な金額の仕訳は rejected に入れる（仕訳ID のない行は行ごとに仮の ID を付ける）
 */
export function groupFreeeJournals(file: FreeeFile): GroupedFreeeJournals {
  const groups = new Map<string, Record<string, string>[]>();
  file.rows.forEach((row, index) => {
    const id = (row[C.journalId] ?? "").trim();
    const key = id === "" ? `#${index + 1}` : id;
    const rows = groups.get(key);
    if (rows === undefined) groups.set(key, [row]);
    else rows.push(row);
  });

  const journals: FreeeJournal[] = [];
  const rejected: RejectedFreeeJournal[] = [];
  for (const [id, rows] of groups) {
    const result = groupOne(id, rows);
    if ("code" in result) rejected.push(result);
    else journals.push(result);
  }
  return { journals, rejected };
}

function groupOne(id: string, rows: Record<string, string>[]): FreeeJournal | RejectedFreeeJournal {
  const first = rows[0] ?? {};
  const rawDate = (first[C.date] ?? "").trim();
  const date = parseFreeeDate(rawDate);
  const journalNo = (first[C.journalNo] ?? "").trim();
  const header = {
    freeeJournalId: id,
    freeeJournalNo: journalNo === "" ? null : journalNo,
    date: date ?? rawDate,
    adjustment: (first[C.adjustment] ?? "").trim() === "1",
  };
  const codes = new Set<FreeeGroupRejectCode>();

  if (id.startsWith("#") || date === undefined) codes.add("MISSING_FIELD");
  if (rows.some((r) => parseFreeeDate(r[C.date] ?? "") !== date)) codes.add("MISSING_FIELD");

  const lineCount = parseNonNegativeInt(first[C.lineCount] ?? "");
  const numbered = rows.map((row) => ({ row, no: parseNonNegativeInt(row[C.lineNo] ?? "") }));
  if (lineCount === undefined || numbered.some((n) => n.no === undefined)) {
    codes.add("MISSING_FIELD");
  } else {
    const nos = numbered.map((n) => n.no ?? 0).sort((a, b) => a - b);
    if (rows.length !== lineCount || nos.some((no, i) => no !== i + 1)) {
      codes.add("LINE_COUNT_MISMATCH");
    }
  }

  const ordered = [...numbered].sort((a, b) => (a.no ?? 0) - (b.no ?? 0));
  const lines: FreeeJournalLine[] = [];
  const remarks: string[] = [];
  for (const { row } of ordered) {
    const description = row[C.description] ?? "";
    for (const side of ["debit", "credit"] as const) {
      const r = (row[C[side].remarks] ?? "").trim();
      if (r !== "" && !remarks.includes(r)) remarks.push(r);
      const result = readSide(row, side, description);
      if (result === undefined) continue;
      if (result.ok) lines.push(result.line);
      else codes.add(result.code);
    }
  }

  const code = REJECT_ORDER.find((c) => codes.has(c));
  if (code !== undefined) return { ...header, code };
  return {
    freeeJournalId: id,
    freeeJournalNo: header.freeeJournalNo,
    date: header.date,
    adjustment: header.adjustment,
    entryMethod: (first[C.entryMethod] ?? "").trim(),
    memo: remarks.length === 0 ? undefined : remarks.join("\n"),
    lines,
  };
}

// ---- 総勘定元帳（research R6, R7） ----

/** 元帳の開始行の相手勘定科目（初年は「開始残高」） */
export const LEDGER_OPENING_COUNTERPARTS: readonly string[] = ["前期繰越", "開始残高"];

/** 元帳の取引の行（開始行を除く） */
export type FreeeLedgerRow = {
  /** YYYY-MM-DD */
  date: string;
  /** 決算整理仕訳 = 1 */
  adjustment: boolean;
  /** 相手勘定科目（normalizeName 済み。相手が複数なら「諸口」） */
  counterpart: string;
  journalNo: string | null;
  /** 空欄は 0 */
  debit: number;
  credit: number;
  /** 科目の通常の側を正とする符号つきの残高（freee の表記のまま） */
  balance: number;
};

/** 元帳の科目ごとのブロック（data-model §3） */
export type FreeeLedgerAccount = {
  /** normalizeName 済みの勘定科目名 */
  accountName: string;
  /** 開始行（前期繰越・開始残高）の残高（符号つき）。年初付の決算振替の前の値。開始行がなければ 0 */
  opening: number;
  /** 開始行の取引日。開始行がなければ null */
  openingDate: string | null;
  /** 残高の動きから推定した、freee の科目の通常の側。動きのある行がなければ undefined */
  normalSide?: Side | undefined;
  /** 開始行を除く行（ファイルの順） */
  rows: FreeeLedgerRow[];
};

export type FreeeLedgerError = {
  code: "INVALID_AMOUNT" | "MISSING_FIELD";
  /** データの行番号（ヘッダの次の行を 1 とする） */
  row: number;
  column: string;
};

const L = LEDGER_COLUMNS;
const SIGNED_INTEGER_PATTERN = /^-?\d+$/;

/** 符号つきの整数（3桁区切りのカンマは許す）。それ以外は undefined */
function parseSignedInt(value: string): number | undefined {
  const v = value.trim().replaceAll(",", "");
  if (!SIGNED_INTEGER_PATTERN.test(v)) return undefined;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n + 0 : undefined;
}

/** 前の残高からの増減と借方・貸方から、通常の側を推定する（決まらなければ undefined） */
function inferNormalSide(opening: number, rows: readonly FreeeLedgerRow[]): Side | undefined {
  let previous = opening;
  for (const r of rows) {
    const movement = r.debit - r.credit;
    const delta = r.balance - previous;
    previous = r.balance;
    if (movement === 0) continue;
    if (delta === movement) return "debit";
    if (delta === -movement) return "credit";
  }
  return undefined;
}

/**
 * 元帳の行を勘定科目ごとにまとめる（research R6, R7）。科目は初出の順、行はファイルの順。
 * 相手勘定科目が「前期繰越」「開始残高」の行を開始行とし、その残高を opening にする（同じ科目に2つあれば先の行）。
 * 金額・残高が整数でなければ INVALID_AMOUNT、勘定科目・日付が読めなければ MISSING_FIELD
 */
export function parseFreeeLedger(file: FreeeFile): Result<FreeeLedgerAccount[], FreeeLedgerError> {
  const accounts = new Map<string, FreeeLedgerAccount>();
  for (const [index, row] of file.rows.entries()) {
    const fail = (code: FreeeLedgerError["code"], column: string) => ({
      ok: false as const,
      error: { code, row: index + 1, column },
    });
    const accountName = normalizeName(row[L.account] ?? "");
    if (accountName === "") return fail("MISSING_FIELD", L.account);
    const date = parseFreeeDate(row[L.date] ?? "");
    if (date === undefined) return fail("MISSING_FIELD", L.date);
    const balance = parseSignedInt(row[L.balance] ?? "");
    if (balance === undefined) return fail("INVALID_AMOUNT", L.balance);

    let account = accounts.get(accountName);
    if (account === undefined) {
      account = { accountName, opening: 0, openingDate: null, rows: [] };
      accounts.set(accountName, account);
    }
    const counterpart = normalizeName(row[L.counterpart] ?? "");
    if (LEDGER_OPENING_COUNTERPARTS.includes(counterpart)) {
      if (account.openingDate === null) {
        account.opening = balance;
        account.openingDate = date;
      }
      continue;
    }

    const amounts: Record<Side, number> = { debit: 0, credit: 0 };
    for (const side of ["debit", "credit"] as const) {
      const text = (row[L[side]] ?? "").trim();
      if (text === "") continue;
      const amount = parseSignedInt(text);
      if (amount === undefined || amount < 0) return fail("INVALID_AMOUNT", L[side]);
      amounts[side] = amount;
    }
    const journalNo = (row[L.journalNo] ?? "").trim();
    account.rows.push({
      date,
      adjustment: (row[L.adjustment] ?? "").trim() === "1",
      counterpart,
      journalNo: journalNo === "" ? null : journalNo,
      debit: amounts.debit,
      credit: amounts.credit,
      balance,
    });
  }
  return {
    ok: true,
    value: [...accounts.values()].map((a) => {
      const normalSide = inferNormalSide(a.opening, a.rows);
      return normalSide === undefined ? a : { ...a, normalSide };
    }),
  };
}
