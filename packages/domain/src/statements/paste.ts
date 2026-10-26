import { isValidDate } from "../dates.ts";
import { domainError, err, ok, type Result } from "../types.ts";

/**
 * MF ME の「入出金」の表の貼り付け（タブ区切り）の読み取り（006 R2）。
 * 列は見出しの名前で対応づけ、見出しがなければ既定の並びとみなす。日付は `MM/DD(曜)` で年を持たないので、
 * 呼び出し側が対象の年を渡す
 */

/** 貼り付けの 1 行（`externalId` は自動取得だけが持つ。R3） */
export type PastedRow = {
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

export type MfmePaste = { rows: PastedRow[]; unreadable: UnreadableRow[] };

type ColumnKey =
  | "date"
  | "content"
  | "amount"
  | "accountName"
  | "categoryMajor"
  | "categoryMinor"
  | "memo"
  | "transferFlag";

/**
 * 列の対応表（見出しの名前 → 項目）。MF ME の表の見出しが違っていれば、ここだけを直す（R2）。
 * 先頭の名前を、欠けた列の報告に使う
 */
export const MFME_COLUMNS = {
  date: ["日付"],
  content: ["内容"],
  amount: ["金額（円）", "金額"],
  accountName: ["保有金融機関"],
  categoryMajor: ["大項目"],
  categoryMinor: ["中項目"],
  memo: ["メモ"],
  transferFlag: ["振替"],
} as const satisfies Record<ColumnKey, readonly string[]>;

/** 見出しがないときの並び（R2） */
const DEFAULT_ORDER: readonly ColumnKey[] = [
  "date",
  "content",
  "amount",
  "accountName",
  "categoryMajor",
  "categoryMinor",
  "memo",
  "transferFlag",
];

const REQUIRED: readonly ColumnKey[] = ["date", "content", "amount", "accountName"];

const MAX_AMOUNT = 1_000_000_000_000;
const TRUE_VALUES = new Set(["1", "○", "◯", "true", "yes", "はい", "振替"]);

const norm = (s: string): string => s.normalize("NFKC").trim();

const columnKeyOf = (cell: string): ColumnKey | undefined => {
  const name = norm(cell);
  for (const key of Object.keys(MFME_COLUMNS) as ColumnKey[]) {
    if (MFME_COLUMNS[key].some((n) => norm(n) === name)) return key;
  }
  return undefined;
};

/** `MM/DD(曜)`・`MM/DD`・`YYYY/MM/DD`（区切りは `/` か `-`）を YYYY-MM-DD にする。読めなければ undefined */
function parseDate(raw: string, year: number): string | undefined {
  const s = norm(raw);
  const full = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(s);
  const short = /^(\d{1,2})[/-](\d{1,2})(?:\([^)]*\))?$/.exec(s);
  const parts = full
    ? [full[1], full[2], full[3]]
    : short
      ? [String(year), short[1], short[2]]
      : undefined;
  if (parts === undefined) return undefined;
  const [y, m, d] = parts as [string, string, string];
  const date = `${y.padStart(4, "0")}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  return isValidDate(date) ? date : undefined;
}

/** 金額の `,`・`¥`・`円`・`−`（U+2212）・`-`・`+` を読む。整数以外は undefined */
function parseAmount(raw: string): number | undefined | "large" {
  const s = norm(raw)
    .replace(/[−‐‑–—]/g, "-")
    .replace(/[,¥￥円\s]/g, "");
  if (!/^[+-]?\d+$/.test(s)) return undefined;
  const n = Number(s);
  return Math.abs(n) >= MAX_AMOUNT ? "large" : n;
}

const optional = (cell: string | undefined): string | undefined => {
  const s = cell?.trim();
  return s === undefined || s === "" ? undefined : s;
};

/**
 * 貼り付けのテキストを行にする。読めない行（合計・別の画面の文字など）は `{ line, reason }` で返し、
 * 読めた行だけを `rows` に入れる。必須の列（日付・内容・金額・保有金融機関）がそろわないか、1 行も読めなければ
 * `STATEMENT_PASTE_UNREADABLE`（何も加えない）
 */
export function parseMfmePaste(text: string, year: number): Result<MfmePaste> {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r\n|\n|\r/)
    .map((raw, i) => ({ no: i + 1, cells: raw.split("\t") }))
    .filter((l) => l.cells.some((c) => c.trim() !== ""));

  const unreadableError = (message: string, details: Record<string, unknown>) =>
    err(domainError("STATEMENT_PASTE_UNREADABLE", message, details));

  const first = lines[0];
  if (first === undefined) {
    return unreadableError("貼り付けのテキストが空です", { unreadable: [] });
  }

  // 見出し: 先頭の行に、対応表にある名前が 1 つでもあれば見出しとみなす
  const headerKeys = first.cells.map(columnKeyOf);
  const hasHeader = headerKeys.some((k) => k !== undefined);
  const columnOf = new Map<ColumnKey, number>();
  if (hasHeader) {
    headerKeys.forEach((key, index) => {
      if (key !== undefined && !columnOf.has(key)) columnOf.set(key, index);
    });
    const missing = REQUIRED.filter((k) => !columnOf.has(k)).map((k) => MFME_COLUMNS[k][0]);
    if (missing.length > 0) {
      return unreadableError("必須の列が足りません", { missingColumns: missing, unreadable: [] });
    }
  } else {
    DEFAULT_ORDER.forEach((key, index) => {
      columnOf.set(key, index);
    });
  }
  // 必須の列の最大の位置（これより短い行は「列が足りません」）
  const requiredWidth = Math.max(...REQUIRED.map((k) => columnOf.get(k) as number)) + 1;

  const rows: PastedRow[] = [];
  const unreadable: UnreadableRow[] = [];
  for (const { no, cells } of hasHeader ? lines.slice(1) : lines) {
    const cell = (key: ColumnKey): string | undefined => {
      const index = columnOf.get(key);
      return index === undefined ? undefined : cells[index];
    };
    const reject = (reason: string) => unreadable.push({ line: no, reason });

    if (cells.length < requiredWidth) {
      reject("列が足りません");
      continue;
    }
    const date = parseDate(cell("date") ?? "", year);
    if (date === undefined) {
      reject("日付を読めません");
      continue;
    }
    const content = (cell("content") ?? "").trim();
    if (content === "") {
      reject("内容が空です");
      continue;
    }
    const accountName = (cell("accountName") ?? "").trim();
    if (accountName === "") {
      reject("保有金融機関が空です");
      continue;
    }
    const amount = parseAmount(cell("amount") ?? "");
    if (amount === undefined) {
      reject("金額を読めません");
      continue;
    }
    if (amount === "large") {
      reject("金額が大きすぎます");
      continue;
    }

    const row: PastedRow = {
      accountName,
      date,
      content,
      amount,
      transferFlag: TRUE_VALUES.has(norm(cell("transferFlag") ?? "").toLowerCase()),
    };
    const categoryMajor = optional(cell("categoryMajor"));
    const categoryMinor = optional(cell("categoryMinor"));
    const memo = optional(cell("memo"));
    if (categoryMajor !== undefined) row.categoryMajor = categoryMajor;
    if (categoryMinor !== undefined) row.categoryMinor = categoryMinor;
    if (memo !== undefined) row.memo = memo;
    rows.push(row);
  }

  if (rows.length === 0) {
    return unreadableError("読める行がありません", { unreadable });
  }
  return ok({ rows, unreadable });
}
