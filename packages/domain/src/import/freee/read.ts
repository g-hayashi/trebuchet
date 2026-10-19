import type { Result } from "../../types.ts";
import { decodeText, parseCsv, type TextEncodingName } from "../csv.ts";
import { JOURNAL_COLUMN_NAMES, LEDGER_COLUMN_NAMES } from "./columns.ts";

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
