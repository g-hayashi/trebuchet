import { describe, expect, it } from "vitest";
import { decodeText } from "../../src/import/csv.ts";
import {
  detectTableLayout,
  MAX_STATEMENT_COLUMNS,
  MAX_STATEMENT_ROWS,
} from "../../src/statements/table.ts";
import {
  ALL_STATEMENT_FIXTURES,
  BANK_TWO_COLUMNS,
  BANK_WAREKI,
  CARD_OUTFLOW_POSITIVE,
  CUSTOM_HEADER,
  type ExpectedStatementFixture,
  MFME_PASTE,
  NO_HEADER,
} from "../fixtures/statements/expected.ts";
import { readStatementFixture } from "../fixtures/statements/load.ts";

// 007/R2（区切り文字と見出しの行の判定）・R6（needsYear）・R12（上限）

const textOf = (f: ExpectedStatementFixture): string =>
  decodeText(readStatementFixture(f.file)).text;

function detect(text: string, override?: Parameters<typeof detectTableLayout>[1]) {
  const result = detectTableLayout(text, override);
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

describe("detectTableLayout: T001 のフィクスチャ", () => {
  it.each(ALL_STATEMENT_FIXTURES.map((f) => [f.file, f] as const))(
    "%s: 区切り文字・見出しの行・見出し・案・行数が正しい",
    (_name, fixture) => {
      const layout = detect(textOf(fixture));
      expect(layout.delimiter).toBe(fixture.mapping.delimiter);
      expect(layout.headerRow).toBe(fixture.mapping.headerRow);
      expect(layout.rowCount).toBe(fixture.rowCount);
      expect(layout.sampleRows.length).toBe(Math.min(10, fixture.rowCount));
      expect(layout.header === null).toBe(fixture.mapping.headerRow === null);
    },
  );

  it("MF ME の貼り付け: タブ・見出しは 0 行目・列がすべてそろう案・年のない日付", () => {
    const layout = detect(textOf(MFME_PASTE));
    expect(layout.header?.[1]).toBe("日付");
    expect(layout.columnCount).toBe(10);
    expect(layout.suggestedColumns).toEqual(MFME_PASTE.mapping.columns);
    expect(layout.needsYear).toBe(true);
  });

  it("銀行の CSV（前置き 3 行）: 前置きは見本に入らず、見出しの行は 3", () => {
    const layout = detect(textOf(BANK_TWO_COLUMNS));
    expect(layout.headerRow).toBe(BANK_TWO_COLUMNS.preambleLines);
    expect(layout.header).toEqual(["取引日", "摘要", "出金額", "入金額", "残高"]);
    expect(layout.columnCount).toBe(5);
    expect(layout.suggestedColumns).toEqual(BANK_TWO_COLUMNS.mapping.columns);
    expect(layout.sampleRows[0]?.[0]).toBe("2026/10/01");
    expect(layout.needsYear).toBe(false);
    expect(JSON.stringify(layout.sampleRows)).not.toContain("口座番号");
  });

  it("CP932 の CSV と UTF-8 の元は同じ結果", () => {
    const cp932 = detect(textOf(BANK_TWO_COLUMNS));
    const utf8 = detect(decodeText(readStatementFixture("bank-two-columns.utf8.csv")).text);
    expect(utf8).toEqual(cp932);
  });

  it("カードの CSV: 引用の中のカンマで区切りを取り違えない", () => {
    const layout = detect(textOf(CARD_OUTFLOW_POSITIVE));
    expect(layout.delimiter).toBe(",");
    expect(layout.suggestedColumns).toEqual(CARD_OUTFLOW_POSITIVE.mapping.columns);
  });

  it("和暦の CSV: 年を選ばせない（needsYear が false）", () => {
    const layout = detect(textOf(BANK_WAREKI));
    expect(layout.needsYear).toBe(false);
    expect(layout.suggestedColumns).toEqual(BANK_WAREKI.mapping.columns);
  });

  it("見出しなし: header は null・案は空・見本は先頭 10 行以内", () => {
    const layout = detect(textOf(NO_HEADER));
    expect(layout.headerRow).toBeNull();
    expect(layout.header).toBeNull();
    expect(layout.suggestedColumns).toEqual({});
    expect(layout.columnCount).toBe(4);
    expect(layout.sampleRows[0]).toEqual(["2026/10/01", "振込 テスト商事", "330000", "1330000"]);
  });

  it("見出しなし＋前置き: 最頻値の列数を持つ最初の行より前は前置きで、見本・行数に入らない（R2-3）", () => {
    const text =
      "ご案内\n対象期間,作成 10/05\n2026/10/01,A,100\n2026/10/02,B,200\n2026/10/03,C,300\n";
    const layout = detect(text);
    expect(layout.headerRow).toBeNull();
    expect(layout.header).toBeNull();
    expect(layout.columnCount).toBe(3);
    expect(layout.rowCount).toBe(3);
    expect(layout.sampleRows).toEqual([
      ["2026/10/01", "A", "100"],
      ["2026/10/02", "B", "200"],
      ["2026/10/03", "C", "300"],
    ]);
    // 前置きの `10/05` は年の判定に使わない
    expect(layout.needsYear).toBe(false);
  });

  it("見出しなし（選び直し）＋前置き: 前置きは見本・行数に入らない", () => {
    const text = "ご案内\n2026/10/01,A,100\n2026/10/02,B,200\n";
    const layout = detect(text, { headerRow: null });
    expect(layout.rowCount).toBe(2);
    expect(layout.sampleRows[0]).toEqual(["2026/10/01", "A", "100"]);
  });

  it("辞書にない見出し: 日付・金額に読めない行で、次の行に日付があれば見出し（案は空）", () => {
    const layout = detect(textOf(CUSTOM_HEADER));
    expect(layout.headerRow).toBe(0);
    expect(layout.header).toEqual(["発生日", "取引の内容", "増減額", "整理番号"]);
    expect(layout.suggestedColumns).toEqual({});
    expect(layout.rowCount).toBe(CUSTOM_HEADER.rowCount);
  });
});

describe("detectTableLayout: 区切り文字の採点（R2-1）", () => {
  it("同点はタブ → カンマ → セミコロンの順", () => {
    expect(detect("a,b\tc\nd,e\tf\n").delimiter).toBe("\t");
    expect(detect("a,b;c\nd,e;f\n").delimiter).toBe(",");
    expect(detect("a;b\nc;d\n").delimiter).toBe(";");
  });

  it("その列数の行の割合が高い方を選ぶ", () => {
    // カンマで切ると 2 列と 3 列が混じる。タブはすべて 3 列
    const text = "日付\t内容\t金額\n10/01\tA,B\t1,200\n10/02\tC\t500\n10/03\tD\t300\n";
    expect(detect(text).delimiter).toBe("\t");
  });

  it("1 セルの前置きの行があっても、2 列以上の行で判定する", () => {
    const text = "説明\n説明2\n説明3\n日付;内容;金額\n10/01;A;100\n10/02;B;200\n";
    const layout = detect(text);
    expect(layout.delimiter).toBe(";");
    expect(layout.headerRow).toBe(3);
  });

  it("区切りが見つからない（1 列だけ）ときもタブで返す（利用者が選び直せる）", () => {
    const layout = detect("abc\ndef\n");
    expect(layout.delimiter).toBe("\t");
    expect(layout.columnCount).toBe(1);
  });
});

describe("detectTableLayout: 見出しの行（R2-2）", () => {
  it("辞書に当たる最初の行（最頻値の列数の行だけ）", () => {
    const text = "日付,金額\n日付,内容,金額\n10/01,A,100\n";
    // 1 行目は 2 列（最頻値は 3 列ではなく 2 列と 3 列が同数 → 大きい方の 3）なので対象外
    const layout = detect(text);
    expect(layout.headerRow).toBe(1);
    expect(layout.suggestedColumns).toEqual({ date: 0, content: 1, amount: 2 });
  });

  it("見出しの 2 段目の規則: 前置きの後の日付を含まない行が見出し", () => {
    const text = "前置き,説明\nコード,名称,数量\n2026/10/01,A,1\n2026/10/02,B,2\n";
    const layout = detect(text);
    expect(layout.headerRow).toBe(1);
    expect(layout.header).toEqual(["コード", "名称", "数量"]);
    expect(layout.suggestedColumns).toEqual({});
  });

  it("見出しは空のセルを含まない（空のセルがあれば 2 段目の規則の対象外）", () => {
    const text = "コード,,数量\n2026/10/01,A,1\n2026/10/02,B,2\n";
    expect(detect(text).headerRow).toBeNull();
  });

  it("空行は行の番号に数える（元のテキストの行の番号）", () => {
    const text = "説明,補足\n\n日付,内容,金額\n10/01,A,100\n";
    expect(detect(text).headerRow).toBe(2);
  });
});

describe("detectTableLayout: 見本・行数・needsYear", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => `2026/10/01,店${i},${i + 1}`);

  it("見本は見出しより後の先頭 10 行。rowCount は空でない行の数", () => {
    const text = ["日付,内容,金額", ...rows(25), "", ""].join("\n");
    const layout = detect(text);
    expect(layout.sampleRows).toHaveLength(10);
    expect(layout.sampleRows[0]?.[1]).toBe("店0");
    expect(layout.rowCount).toBe(25);
  });

  it("見出しなしのとき、日付として読めるセルを持つ列で needsYear を決める", () => {
    expect(detect("10/01,A,100\n10/02,B,200\n").needsYear).toBe(true);
    expect(detect("2026/10/01,A,100\n10/02(金),B,200\n").needsYear).toBe(true);
    expect(detect("2026/10/01,A,100\n2026/10/02,B,200\n").needsYear).toBe(false);
  });

  it("見出しの案の日付の列だけを見る（他の列の `MM/DD` に見える値は年の判定に使わない）", () => {
    const text = "日付,内容,金額\n2026/10/01,10/05,100\n2026/10/02,B,200\n";
    expect(detect(text).needsYear).toBe(false);
  });
});

describe("detectTableLayout: 選び直し（override）", () => {
  const text = "A;B,C\n1;2,3\n4;5,6\n";

  it("delimiter を指定すれば採点しない", () => {
    expect(detect(text, { delimiter: ";" }).columnCount).toBe(2);
    expect(detect(text, { delimiter: "," }).columnCount).toBe(2);
    expect(detect(text, { delimiter: "\t" }).columnCount).toBe(1);
  });

  it("headerRow を指定すれば見出しの判定をしない。その行より前は前置き", () => {
    const t = "日付,内容,金額\n10/01,A,100\n10/02,B,200\n10/03,C,300\n";
    const layout = detect(t, { headerRow: 1 });
    expect(layout.headerRow).toBe(1);
    expect(layout.header).toEqual(["10/01", "A", "100"]);
    expect(layout.rowCount).toBe(2);
    // 見出しを指定したので、案はその行から作る（辞書に当たらず空）
    expect(layout.suggestedColumns).toEqual({});
  });

  it("headerRow が null なら見出しなし。全行がデータ", () => {
    const t = "日付,内容,金額\n10/01,A,100\n";
    const layout = detect(t, { headerRow: null });
    expect(layout.headerRow).toBeNull();
    expect(layout.header).toBeNull();
    expect(layout.rowCount).toBe(2);
    expect(layout.suggestedColumns).toEqual({});
  });

  it("headerRow が行の外ならエラー", () => {
    const result = detectTableLayout("日付,内容\n10/01,A\n", { headerRow: 9 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("STATEMENT_TABLE_UNREADABLE");
  });
});

describe("detectTableLayout: 失敗（R12）", () => {
  it("空・空白だけのテキストは STATEMENT_TABLE_UNREADABLE", () => {
    for (const text of ["", "  \n\t\n", " \r\n  \n"]) {
      const result = detectTableLayout(text);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("STATEMENT_TABLE_UNREADABLE");
    }
  });

  it("20,000 行まで読める。超えれば STATEMENT_TABLE_TOO_LARGE（details に上限）", () => {
    const body = (n: number) =>
      ["日付,内容,金額", ...Array.from({ length: n }, () => "2026/10/01,A,100")].join("\n");
    expect(MAX_STATEMENT_ROWS).toBe(20_000);
    // 見出しの行を含めて 20,000 行
    expect(detectTableLayout(body(MAX_STATEMENT_ROWS - 1)).ok).toBe(true);
    const result = detectTableLayout(body(MAX_STATEMENT_ROWS));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("STATEMENT_TABLE_TOO_LARGE");
      expect(result.error.details).toEqual({ maxRows: 20_000, maxColumns: 50 });
    }
  });

  it("50 列まで読める。超えれば STATEMENT_TABLE_TOO_LARGE", () => {
    const line = (n: number) => Array.from({ length: n }, (_, i) => `c${i}`).join(",");
    expect(MAX_STATEMENT_COLUMNS).toBe(50);
    expect(detectTableLayout(`${line(50)}\n${line(50)}\n`).ok).toBe(true);
    const result = detectTableLayout(`${line(51)}\n${line(51)}\n`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("STATEMENT_TABLE_TOO_LARGE");
  });
});
