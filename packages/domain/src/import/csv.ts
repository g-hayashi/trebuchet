export type TextEncodingName = "utf-8" | "shift_jis";

export type DecodedText = { text: string; encoding: TextEncodingName };

/**
 * バイト列を文字列にする（research R1）。UTF-8 として厳密に読めれば UTF-8（BOM は除く）、
 * 読めなければ Shift_JIS（WHATWG の定義で CP932 の拡張文字を含む）とみなす。
 * 行の分割はデコードの後に行う（CP932 の2バイト目の 0x85 などを改行と誤認しないため）
 */
export function decodeText(bytes: Uint8Array): DecodedText {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("shift_jis").decode(bytes), encoding: "shift_jis" };
  }
}

/**
 * RFC 4180 の CSV を行の配列にする（research R2）。引用、`""` のエスケープ、引用内の改行を扱う。
 * 行末は CRLF・LF・CR のどれでもよい。末尾の空行は捨てる。BOM は除かない（decodeText で除く）。
 * 閉じていない引用は、ファイルの終わりまでを値とする
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let fieldStart = true;
  let lineStart = true;
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i] as string;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        field += c;
      }
      i++;
      continue;
    }
    lineStart = false;
    if (c === '"' && fieldStart) {
      quoted = true;
      fieldStart = false;
    } else if (c === ",") {
      row.push(field);
      field = "";
      fieldStart = true;
    } else if (c === "\r" || c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      fieldStart = true;
      lineStart = true;
      if (c === "\r" && text[i + 1] === "\n") i++;
    } else {
      field += c;
      fieldStart = false;
    }
    i++;
  }
  if (!lineStart) {
    row.push(field);
    rows.push(row);
  }
  while (rows.length > 0) {
    const last = rows[rows.length - 1] as string[];
    if (last.length !== 1 || last[0] !== "") break;
    rows.pop();
  }
  return rows;
}
