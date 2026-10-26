import { describe, expect, it } from "vitest";
import { parseCsv, parseDelimited, parseDelimitedLines } from "../../src/import/csv.ts";

describe("parseDelimited（区切り文字つきの分割。007/R3）", () => {
  it("タブで分割する。カンマはそのまま値に残る", () => {
    expect(parseDelimited("日付\t内容\t金額\n10/01\tA,B\t-1,200\n", "\t")).toEqual([
      ["日付", "内容", "金額"],
      ["10/01", "A,B", "-1,200"],
    ]);
  });

  it("セミコロンで分割する", () => {
    expect(parseDelimited("a;b;c\r\n1;2;3\r\n", ";")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("引用の中の区切り文字は値になる（タブ・セミコロン）", () => {
    expect(parseDelimited('"a\tb"\tc\n', "\t")).toEqual([["a\tb", "c"]]);
    expect(parseDelimited('"a;b";c\n', ";")).toEqual([["a;b", "c"]]);
  });

  it('引用の中の "" は " になる', () => {
    expect(parseDelimited('"say ""hi""";x\n', ";")).toEqual([['say "hi"', "x"]]);
    expect(parseDelimited('"say ""hi"""\tx\n', "\t")).toEqual([['say "hi"', "x"]]);
  });

  it("引用の中の改行は値になる（LF と CRLF）", () => {
    expect(parseDelimited('"a\nb"\tc\n1\t2\n', "\t")).toEqual([
      ["a\nb", "c"],
      ["1", "2"],
    ]);
    expect(parseDelimited('"a\r\nb";c\r\n', ";")).toEqual([["a\r\nb", "c"]]);
  });

  it("区切り文字でない文字のカンマは分割しない", () => {
    expect(parseDelimited("a,b\tc\n", "\t")).toEqual([["a,b", "c"]]);
  });

  it("引用はフィールドの先頭だけ。途中の引用符は文字として残る", () => {
    expect(parseDelimited('a"b\tc\n', "\t")).toEqual([['a"b', "c"]]);
  });

  it("末尾の空行は捨てる。空の値は残る", () => {
    expect(parseDelimited("a\t\tc\n\n\n", "\t")).toEqual([["a", "", "c"]]);
  });

  it("閉じていない引用は、ファイルの終わりまでを値とする", () => {
    expect(parseDelimited('a\t"b\nc', "\t")).toEqual([["a", "b\nc"]]);
  });

  it("parseCsv は parseDelimited(text, ',') と同じ", () => {
    const text = 'a,"b,c",d\n"x\ny",2,3\r\n';
    expect(parseCsv(text)).toEqual(parseDelimited(text, ","));
    expect(parseCsv(text)).toEqual([
      ["a", "b,c", "d"],
      ["x\ny", "2", "3"],
    ]);
  });
});

describe("parseDelimitedLines（行の番号つき）", () => {
  it("各行が始まる元のテキストの行の番号（1 起点）を返す", () => {
    expect(parseDelimitedLines("a\tb\nc\td\ne\tf\n", "\t")).toEqual([
      { line: 1, cells: ["a", "b"] },
      { line: 2, cells: ["c", "d"] },
      { line: 3, cells: ["e", "f"] },
    ]);
  });

  it("引用の中の改行を数える（次の行の番号が進む）", () => {
    expect(parseDelimitedLines('"a\nb\nc"\tx\n1\t2\n', "\t")).toEqual([
      { line: 1, cells: ["a\nb\nc", "x"] },
      { line: 4, cells: ["1", "2"] },
    ]);
  });

  it("CRLF・CR の改行も 1 行として数える。空行の番号も飛ばさない", () => {
    expect(parseDelimitedLines("a;b\r\n\r\nc;d\re;f\r\n", ";")).toEqual([
      { line: 1, cells: ["a", "b"] },
      { line: 2, cells: [""] },
      { line: 3, cells: ["c", "d"] },
      { line: 4, cells: ["e", "f"] },
    ]);
  });

  it("末尾の空行は捨てる", () => {
    expect(parseDelimitedLines("a\tb\n\n\n", "\t")).toEqual([{ line: 1, cells: ["a", "b"] }]);
  });

  it("閉じていない引用でも、始まりの行の番号を返す", () => {
    expect(parseDelimitedLines('a\n"b\nc', "\t")).toEqual([
      { line: 1, cells: ["a"] },
      { line: 2, cells: ["b\nc"] },
    ]);
  });

  it("cells は parseDelimited と同じ", () => {
    const text = 'x\t"y\nz"\t1\n\n2\t3\t4\n';
    expect(parseDelimitedLines(text, "\t").map((r) => r.cells)).toEqual(parseDelimited(text, "\t"));
  });
});
