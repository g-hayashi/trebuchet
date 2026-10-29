import { sha256Hex } from "@trebuchet/db";
import { decodeText, decodeTextAs } from "@trebuchet/domain";
import type { StatementColumnMapping, StatementEncoding } from "@trebuchet/schema";

/**
 * 明細の取込の入力（007。multipart の `file` と `options`）を domain に渡す形にする部品。
 * 文字コードの判定は domain の `decodeText`、利用者の選び直しは `decodeTextAs`（R1）。ここは呼び分けと、入力のハッシュだけ
 */

/** バイト列を文字列にする。`encoding` の指定があればその文字コード、なければ自動の判定（R1） */
export function decodeStatementBytes(
  bytes: Uint8Array,
  encoding?: StatementEncoding | undefined,
): { text: string; encoding: StatementEncoding } {
  if (encoding === undefined) return decodeText(bytes);
  return { text: decodeTextAs(bytes, encoding), encoding };
}

/**
 * 入力の SHA-256（R11。domain に暗号の関数を入れないので server で計算する）。
 * `sha256Hex(JSON.stringify({ text, year, mapping, fixedAccountName }))` で、キーの順を固定した正規の JSON にする:
 * mapping は delimiter・headerRow・columns（役割の名前の順）・amountSign、未指定は null。
 * 同じテキストでも、年・対応・口座名が違えば別の計画になる
 */
export function statementInputSha256(input: {
  text: string;
  year: number;
  mapping: StatementColumnMapping;
  fixedAccountName?: string | undefined;
}): string {
  const { mapping } = input;
  const columns: Record<string, number> = {};
  for (const role of Object.keys(mapping.columns).sort()) {
    const index = (mapping.columns as Record<string, number | undefined>)[role];
    if (index !== undefined) columns[role] = index;
  }
  const canonical = JSON.stringify({
    text: input.text,
    year: input.year,
    mapping: {
      delimiter: mapping.delimiter,
      headerRow: mapping.headerRow,
      columns,
      amountSign: mapping.amountSign ?? null,
    },
    fixedAccountName: input.fixedAccountName ?? null,
  });
  return sha256Hex(new TextEncoder().encode(canonical));
}
