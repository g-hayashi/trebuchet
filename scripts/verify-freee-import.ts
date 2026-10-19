/**
 * freee の書き出しファイルの確認（research R3・R18、ローカル専用）。実データは読むだけで、出力もコミットしない。
 *
 *   pnpm verify:freee --headers-only --journal <仕訳帳.csv> --ledger <総勘定元帳.csv>
 *
 * --headers-only: 判定した文字コード、ヘッダで見つからない列名、メモの列の値に含まれる記号の種類
 * （区切り文字の候補）を出す。値・金額・取引先は出さない。
 *
 * ルートは @trebuchet/* に依存しないため、ワークスペースのソースを相対パスで読み込む。
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { decodeText, parseCsv } from "../packages/domain/src/import/csv.ts";
import {
  JOURNAL_COLUMN_NAMES,
  JOURNAL_COLUMNS,
  LEDGER_COLUMN_NAMES,
} from "../packages/domain/src/import/freee/columns.ts";

const HEADER_SEARCH_ROWS = 5;
const MEMO_COLUMNS = [JOURNAL_COLUMNS.debit.memo, JOURNAL_COLUMNS.credit.memo];
// 英数字（全角を含む）・かな・漢字などの文字。これ以外を区切り文字の候補とする
const WORD_CHAR = /[\p{L}\p{N}]/u;

type FileKind = { label: string; columns: readonly string[]; memoColumns: readonly string[] };

const KINDS = {
  journal: { label: "仕訳帳", columns: JOURNAL_COLUMN_NAMES, memoColumns: MEMO_COLUMNS },
  ledger: { label: "総勘定元帳", columns: LEDGER_COLUMN_NAMES, memoColumns: [] },
} satisfies Record<string, FileKind>;

function usage(message: string): never {
  console.error(message);
  console.error(
    "使い方: node scripts/verify-freee-import.ts --headers-only [--journal <path>] [--ledger <path>]",
  );
  process.exit(2);
}

/** 先頭の数行から、列名の一致が最も多い行をヘッダとする */
function findHeader(rows: readonly string[][], columns: readonly string[]) {
  let best: { index: number; header: string[]; hits: number } | undefined;
  for (const [index, row] of rows.slice(0, HEADER_SEARCH_ROWS).entries()) {
    const header = row.map((name) => name.trim());
    const hits = columns.filter((c) => header.includes(c)).length;
    if (hits > 0 && (best === undefined || hits > best.hits)) best = { index, header, hits };
  }
  return best;
}

function describeChar(ch: string): string {
  const code = ch.codePointAt(0) ?? 0;
  const hex = `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
  return /\s/u.test(ch) ? `(空白) ${hex}` : `${JSON.stringify(ch)} ${hex}`;
}

/** 戻り値: 問題がなければ true */
function verifyHeaders(path: string, kind: FileKind): boolean {
  console.log(`## ${kind.label}`);
  const { text, encoding } = decodeText(readFileSync(path));
  console.log(`文字コード: ${encoding}`);

  const rows = parseCsv(text);
  const found = findHeader(rows, kind.columns);
  if (found === undefined) {
    console.log(`ヘッダ: 先頭 ${HEADER_SEARCH_ROWS} 行に既知の列名がない`);
    return false;
  }
  console.log(`ヘッダ: ${found.index + 1} 行目（${found.header.length} 列）`);

  const missing = kind.columns.filter((c) => !found.header.includes(c));
  console.log(
    missing.length === 0
      ? `列名: ${kind.columns.length} 列すべてあり`
      : `見つからない列名（${missing.length} / ${kind.columns.length}）: ${missing.join("、")}`,
  );

  for (const column of kind.memoColumns) {
    const at = found.header.indexOf(column);
    if (at < 0) {
      console.log(`${column}: 列がないため調べない`);
      continue;
    }
    // 記号ごとに、その記号を含む値の数を数える（値そのものは出さない）
    const counts = new Map<string, number>();
    let nonEmpty = 0;
    for (const row of rows.slice(found.index + 1)) {
      const value = row[at] ?? "";
      if (value === "") continue;
      nonEmpty++;
      const symbols = new Set([...value].filter((ch) => !WORD_CHAR.test(ch)));
      for (const ch of symbols) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
    const kinds = [...counts]
      .sort((a, b) => b[1] - a[1])
      .map(([ch, n]) => `${describeChar(ch)} ×${n}`);
    console.log(
      `${column}: 値のある行 ${nonEmpty}、記号 ${kinds.length === 0 ? "なし" : kinds.join(", ")}`,
    );
  }
  return missing.length === 0;
}

const { values } = parseArgs({
  options: {
    "headers-only": { type: "boolean", default: false },
    journal: { type: "string" },
    ledger: { type: "string" },
  },
  strict: true,
});

if (!values["headers-only"]) {
  usage("--headers-only 以外のモード（取込との照合）は未実装（T070）");
}
if (values.journal === undefined && values.ledger === undefined) {
  usage("--journal か --ledger のファイルを指定する");
}

let ok = true;
if (values.journal !== undefined) ok = verifyHeaders(values.journal, KINDS.journal) && ok;
if (values.ledger !== undefined) ok = verifyHeaders(values.ledger, KINDS.ledger) && ok;
process.exit(ok ? 0 : 1);
