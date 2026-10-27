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
 * 文字コードを指定してバイト列を文字列にする（利用者の選び直し。007/R1）。自動の判定はしない。
 * 読めない並びは U+FFFD になる（例外にしない）。UTF-8 の BOM は除く
 */
export function decodeTextAs(bytes: Uint8Array, encoding: TextEncodingName): string {
  return new TextDecoder(encoding).decode(bytes);
}

/** 区切りつきの分割の 1 行。line は、その行が始まる元のテキストの行の番号（1 起点。引用の中の改行も数える） */
export type DelimitedLine = { line: number; cells: string[] };

/**
 * 区切り文字つきのテキストを、行の番号つきの行の配列にする（007/R3）。
 * 引用（`"`）、`""` のエスケープ、引用内の区切り・改行は、どの区切り文字でも同じに扱う。
 * 行末は CRLF・LF・CR のどれでもよい。末尾の空行は捨てる。BOM は除かない（decodeText で除く）。
 * 閉じていない引用は、ファイルの終わりまでを値とする
 */
export function parseDelimitedLines(text: string, delimiter: string): DelimitedLine[] {
  const rows: DelimitedLine[] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let fieldStart = true;
  let lineStart = true;
  let line = 1;
  let rowLine = 1;
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i] as string;
    // CRLF は 1 回だけ数える（CR は次が LF のときは数えない）
    if (c === "\n" || (c === "\r" && text[i + 1] !== "\n")) line++;
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
    } else if (c === delimiter) {
      row.push(field);
      field = "";
      fieldStart = true;
    } else if (c === "\r" || c === "\n") {
      row.push(field);
      rows.push({ line: rowLine, cells: row });
      row = [];
      field = "";
      fieldStart = true;
      lineStart = true;
      if (c === "\r" && text[i + 1] === "\n") {
        i++;
        line++; // 読み飛ばした LF の分
      }
      rowLine = line;
    } else {
      field += c;
      fieldStart = false;
    }
    i++;
  }
  if (!lineStart) {
    row.push(field);
    rows.push({ line: rowLine, cells: row });
  }
  while (rows.length > 0) {
    const last = (rows[rows.length - 1] as DelimitedLine).cells;
    if (last.length !== 1 || last[0] !== "") break;
    rows.pop();
  }
  return rows;
}

/** 区切り文字つきのテキストを行の配列にする（行の番号は要らないとき。`parseDelimitedLines` の cells だけ） */
export function parseDelimited(text: string, delimiter: string): string[][] {
  return parseDelimitedLines(text, delimiter).map((r) => r.cells);
}

/**
 * RFC 4180 の CSV を行の配列にする（research R2）。引用、`""` のエスケープ、引用内の改行を扱う。
 * `parseDelimited(text, ",")` と同じ
 */
export function parseCsv(text: string): string[][] {
  return parseDelimited(text, ",");
}
