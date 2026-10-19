import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decodeText, parseCsv } from "../../src/import/csv.ts";
import { encodeCsv } from "../../src/reports/csv.ts";

const BOM = "\uFEFF";

/**
 * 001 の toCsv(report) は帳票を行の配列にしてから encodeCsv(rows) に渡す。
 * 任意の行の配列を往復させるため、toCsv の中身である encodeCsv を直接使う（BOM 付き・CRLF）
 */
const toCsvRows = (rows: readonly (readonly string[])[]): string => encodeCsv(rows);

const withoutBom = (text: string): string => {
  expect(text.startsWith(BOM)).toBe(true);
  return text.slice(BOM.length);
};

const cellArb = fc.string({
  unit: fc.oneof(
    fc.constantFrom('"', ",", "\n", "\r\n", " ", "あ", "漢", "ュ", "Ａ", "　", "ｶ", "－"),
    fc.string({ minLength: 1, maxLength: 1 }),
  ),
  maxLength: 12,
});

const isEmptyLine = (row: readonly string[] | undefined) =>
  row !== undefined && row.length === 1 && row[0] === "";

// 1列で空の行は空行と区別できない。末尾の空行は捨てる仕様のため、最後の行は空行にしない
const rowsArb = fc
  .array(fc.array(cellArb, { minLength: 1, maxLength: 6 }), { maxLength: 10 })
  .filter((rows) => !isEmptyLine(rows.at(-1)));

/** LF で行を終える CSV（テスト用）。値は常に引用符で囲む */
const toLfCsv = (rows: readonly (readonly string[])[]): string =>
  rows.map((r) => `${r.map((v) => `"${v.replaceAll('"', '""')}"`).join(",")}\n`).join("");

describe("parseCsv (INV-17)", () => {
  it("parseCsv(toCsv(rows)) は rows と一致する（BOM を除いて比べる）", () => {
    fc.assert(
      fc.property(rowsArb, (rows) => {
        expect(parseCsv(withoutBom(toCsvRows(rows)))).toEqual(rows);
      }),
    );
  });

  it("LF で終わる行でも往復する", () => {
    fc.assert(
      fc.property(rowsArb, (rows) => {
        expect(parseCsv(toLfCsv(rows))).toEqual(rows);
      }),
    );
  });

  it("LF と CRLF の行末を同じように読む", () => {
    const expected = [
      ["a", "b"],
      ["c", "d"],
    ];
    expect(parseCsv("a,b\nc,d\n")).toEqual(expected);
    expect(parseCsv("a,b\r\nc,d\r\n")).toEqual(expected);
    expect(parseCsv("a,b\r\nc,d")).toEqual(expected);
    expect(parseCsv("a,b\nc,d\r\n")).toEqual(expected);
  });

  it("引用内の改行・カンマ・二重の引用符を値として読む", () => {
    expect(parseCsv('"1行目\n2行目","x,y","say ""hi"""\r\n"a\r\nb",c\n')).toEqual([
      ["1行目\n2行目", "x,y", 'say "hi"'],
      ["a\r\nb", "c"],
    ]);
  });

  it("空の値と空の引用を読み、末尾の空行は捨てる", () => {
    expect(parseCsv(',"",x\n\n\r\n')).toEqual([["", "", "x"]]);
    expect(parseCsv("a\n\nb\n")).toEqual([["a"], [""], ["b"]]);
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("\n\r\n")).toEqual([]);
  });
});

describe("decodeText", () => {
  const utf8 = (s: string) => new TextEncoder().encode(s);

  it("BOM 付きの UTF-8 は utf-8 と判定し、BOM を除く", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("取引日,仕訳ID\n")]);
    expect(decodeText(bytes)).toEqual({ text: "取引日,仕訳ID\n", encoding: "utf-8" });
  });

  it("BOM のない UTF-8 は utf-8 と判定する", () => {
    expect(decodeText(utf8('"勘定科目","残高"\n'))).toEqual({
      text: '"勘定科目","残高"\n',
      encoding: "utf-8",
    });
  });

  it("UTF-8 として不正なバイト列は shift_jis と判定する", () => {
    // CP932 の「あ」(0x82 0xA0)、「日本」(0x93 0xFA 0x96 0x7B)
    const bytes = new Uint8Array([0x82, 0xa0, 0x2c, 0x93, 0xfa, 0x96, 0x7b, 0x0a]);
    expect(decodeText(bytes)).toEqual({ text: "あ,日本\n", encoding: "shift_jis" });
  });

  it("2バイト目が 0x85 の CP932 の文字を含む行が、改行で分割されない", () => {
    // 0x83 0x85 は CP932 のカタカナ（「ュ」）。0x85 は Latin-1 の NEL（次の行）と同じ値
    expect(new TextDecoder("shift_jis").decode(new Uint8Array([0x83, 0x85]))).toBe("ュ");
    const crlf = [0x0d, 0x0a];
    const bytes = new Uint8Array([
      ...[0x61, 0x2c, 0x62, ...crlf], // a,b
      ...[0x83, 0x85, 0x41, 0x2c, 0x83, 0x85, ...crlf], // ュA,ュ
      ...[0x63, 0x2c, 0x64, ...crlf], // c,d
    ]);
    const { text, encoding } = decodeText(bytes);
    expect(encoding).toBe("shift_jis");
    expect(parseCsv(text)).toEqual([
      ["a", "b"],
      ["ュA", "ュ"],
      ["c", "d"],
    ]);
  });
});
