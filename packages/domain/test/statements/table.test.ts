import type { StatementColumnMapping } from "@trebuchet/schema";
import { describe, expect, it } from "vitest";
import { decodeText } from "../../src/import/csv.ts";
import {
  parseStatementAmount,
  parseStatementDate,
  readStatementTable,
  type StatementReadOptions,
} from "../../src/statements/table.ts";
import {
  ALL_STATEMENT_FIXTURES,
  BANK_TWO_COLUMNS,
  BANK_WAREKI,
  CARD_OUTFLOW_POSITIVE,
  MFME_PASTE,
  NO_HEADER,
} from "../fixtures/statements/expected.ts";
import { readStatementFixture } from "../fixtures/statements/load.ts";

// 007/R5（金額）・R6（日付）・値の読み取り

describe("parseStatementAmount（R5）", () => {
  const cases: [string, number | "large" | undefined][] = [
    ["1200", 1200],
    ["1,200", 1200],
    ["+1,200", 1200],
    ["-1,200", -1200],
    ["¥3,300", 3300],
    ["￥3,300", 3300],
    ["1,500円", 1500],
    [" 1 200 ", 1200],
    ["−1,200", -1200], // U+2212
    ["‐1,200", -1200], // U+2010
    ["–1,200", -1200], // U+2013
    ["－１，２００", -1200], // 全角
    ["△20,000", -20000],
    ["▲45,000", -45000],
    ["(80,000)", -80000],
    ["（80,000）", -80000],
    ["△1,000円", -1000],
    ["-¥500", -500],
    ["0", 0],
    ["-0", 0],
    ["999,999,999,999", 999_999_999_999],
    ["1,000,000,000,000", "large"],
    ["-1,000,000,000,000", "large"],
    ["12.5", undefined],
    ["1,200.00", undefined],
    ["USD 12", undefined],
    ["abc", undefined],
    ["", undefined],
    ["-", undefined],
    ["()", undefined],
    ["△", undefined],
    ["1-2", undefined],
  ];
  for (const [raw, expected] of cases) {
    it(`${JSON.stringify(raw)} → ${String(expected)}`, () => {
      expect(parseStatementAmount(raw)).toBe(expected);
    });
  }
});

describe("parseStatementDate（R6）", () => {
  const cases: [string, string | undefined][] = [
    ["2026/10/01", "2026-10-01"],
    ["2026/1/5", "2026-01-05"],
    ["2026-10-01", "2026-10-01"],
    ["2026.10.01", "2026-10-01"],
    ["2026年10月1日", "2026-10-01"],
    ["2026年1月5日", "2026-01-05"],
    ["20261001", "2026-10-01"],
    ["２０２６／１０／０１", "2026-10-01"],
    ["10/01", "2026-10-01"], // 年は引数
    ["10/01(木)", "2026-10-01"],
    ["10/01（木）", "2026-10-01"],
    ["1/5", "2026-01-05"],
    ["2026/10/01 12:34", "2026-10-01"],
    ["2026/10/01 12:34:56", "2026-10-01"],
    ["2026-10-01T12:34:56", "2026-10-01"],
    ["2026/10/01(木) 09:00", "2026-10-01"],
    ["令和8年10月1日", "2026-10-01"],
    ["令和８年１０月１４日", "2026-10-14"],
    ["令和元年5月1日", "2019-05-01"],
    ["R8.10.05", "2026-10-05"],
    ["R8/10/10", "2026-10-10"],
    ["r8/10/10", "2026-10-10"],
    ["R元.5.1", "2019-05-01"],
    ["平成31年4月30日", "2019-04-30"],
    ["平成元年1月8日", "1989-01-08"],
    ["H30.12.28", "2018-12-28"],
    ["H30/12/28", "2018-12-28"],
    // 読まない
    ["31/10/2026", undefined],
    ["2026/13/01", undefined],
    ["2026/02/30", undefined],
    ["02/29", undefined], // 2026 年は平年
    ["13/01", undefined],
    ["令和1年4月30日", undefined], // 平成最終日（元号の範囲の外）
    ["平成31年5月1日", undefined], // 令和
    ["平成元年1月7日", undefined], // 昭和
    ["令和0年1月1日", undefined],
    ["昭和50年1月1日", undefined],
    ["合計", undefined],
    ["", undefined],
    ["2026/10", undefined],
    ["2026101", undefined],
  ];
  for (const [raw, expected] of cases) {
    it(`${JSON.stringify(raw)} → ${String(expected)}`, () => {
      expect(parseStatementDate(raw, 2026)).toBe(expected);
    });
  }

  it("年のない書き方は引数の年を使う（うるう日）", () => {
    expect(parseStatementDate("02/29", 2028)).toBe("2028-02-29");
  });
});

const read = (text: string, mapping: StatementColumnMapping, options: StatementReadOptions) => {
  const r = readStatementTable(text, mapping, options);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

const fixtureText = (f: (typeof ALL_STATEMENT_FIXTURES)[number]) =>
  decodeText(readStatementFixture(f.file)).text;

describe("readStatementTable: フィクスチャ（SC-001）", () => {
  for (const f of ALL_STATEMENT_FIXTURES) {
    it(`${f.file}: 件数と入金・出金の合計が expected と一致する`, () => {
      const options: StatementReadOptions = {
        year: f.year ?? 2026,
        ...("accountName" in f.mapping.columns ? {} : { fixedAccountName: "サンプル口座" }),
      };
      const { rows, unreadable } = read(fixtureText(f), f.mapping, options);
      expect(unreadable).toEqual([]);
      expect(rows).toHaveLength(f.rowCount);
      expect(rows.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0)).toBe(
        f.inflowTotal,
      );
      expect(rows.filter((r) => r.amount < 0).reduce((s, r) => s - r.amount, 0)).toBe(
        f.outflowTotal,
      );
      expect(rows.every((r) => Number.isInteger(r.amount) && r.amount !== 0)).toBe(true);
    });
  }

  it("MF ME の形: 口座・分類・メモ・振替・ID を読む", () => {
    const { rows } = read(fixtureText(MFME_PASTE), MFME_PASTE.mapping, { year: 2026 });
    expect(rows[0]).toEqual({
      accountName: "サンプル銀行",
      date: "2026-10-01",
      content: "ショップ001",
      amount: -1200,
      categoryMajor: "食費",
      categoryMinor: "食料品",
      transferFlag: false,
      externalId: "mf-0001",
    });
    expect(rows[1]).toMatchObject({ memo: "請求書払い", amount: 330_000 });
    expect(rows.filter((r) => r.transferFlag).map((r) => r.externalId)).toEqual([
      "mf-0005",
      "mf-0006",
      "mf-0008",
      "mf-0009",
    ]);
    expect(rows[9]?.amount).toBe(-1200); // U+2212
  });

  it("銀行の 2 列: 前置きを読まず、出金は負・入金は正、出金の列の負の値は入金、0 は値なし", () => {
    const { rows } = read(fixtureText(BANK_TWO_COLUMNS), BANK_TWO_COLUMNS.mapping, {
      year: 2026,
      fixedAccountName: "サンプル銀行",
    });
    expect(rows.map((r) => r.amount)).toEqual([
      330_000, -20_000, -45_000, -330, -80_000, -12_500, 12_500, 12, 110_000, -1_100,
    ]);
    expect(rows.every((r) => r.accountName === "サンプル銀行")).toBe(true);
  });

  it('カードの正が出金: 符号を反転し、引用の中のカンマ・"" を読む', () => {
    const { rows } = read(fixtureText(CARD_OUTFLOW_POSITIVE), CARD_OUTFLOW_POSITIVE.mapping, {
      year: 2026,
      fixedAccountName: "テストカードA",
    });
    expect(rows[0]).toMatchObject({ content: "ショップ001, 本店", amount: -1200 });
    expect(rows[3]).toMatchObject({ content: "ショップ002 返品", amount: 3300, memo: "返品" });
    expect(rows[7]?.content).toBe('ショップ005 "特選"');
  });

  it("和暦の CSV: 日付を行ごとに読む", () => {
    const { rows } = read(fixtureText(BANK_WAREKI), BANK_WAREKI.mapping, {
      year: 2026,
      fixedAccountName: "サンプル銀行",
    });
    expect(rows.map((r) => r.date)).toEqual(BANK_WAREKI.dates);
  });

  it("見出しなし: 全行がデータ", () => {
    const { rows } = read(fixtureText(NO_HEADER), NO_HEADER.mapping, {
      year: 2026,
      fixedAccountName: "サンプル銀行",
    });
    expect(rows).toHaveLength(8);
    expect(rows[0]).toMatchObject({ date: "2026-10-01", amount: 330_000 });
  });
});

const SIMPLE: StatementColumnMapping = {
  delimiter: ",",
  headerRow: 0,
  columns: { date: 0, content: 1, amount: 2 },
  amountSign: "inflow_positive",
};
const SPLIT: StatementColumnMapping = {
  delimiter: ",",
  headerRow: 0,
  columns: { date: 0, content: 1, outflow: 2, inflow: 3 },
};
const OPTS: StatementReadOptions = { year: 2026, fixedAccountName: "口座A" };

const readErr = (text: string, mapping: StatementColumnMapping, options = OPTS) => {
  const r = readStatementTable(text, mapping, options);
  if (r.ok) throw new Error("ok だった");
  return r.error;
};

describe("readStatementTable: 読めない行", () => {
  it("理由と元のテキストの行番号（1 起点）を返し、読めた行だけを rows に入れる", () => {
    const text = [
      "日付,内容,金額", // 1
      "2026/10/01,A,100", // 2
      "合計,,", // 3
      "", // 4（空行は数えない）
      "2026/10/02,,100", // 5
      "2026/10/03,B,abc", // 6
      "2026/10/04,C,", // 7
      "2026/10/05,D,0", // 8
      "2026/10/06,E,1000000000000", // 9
      "2026/10/07", // 10
      "2026/10/08,F,-5", // 11
    ].join("\n");
    const { rows, unreadable } = read(text, SIMPLE, OPTS);
    // 0 円の明細は取り込む（006 の Edge Cases: 候補を作らないだけ）
    expect(rows.map((r) => [r.content, r.amount])).toEqual([
      ["A", 100],
      ["D", 0],
      ["F", -5],
    ]);
    expect(unreadable).toEqual([
      { line: 3, reason: "日付を読めません" },
      { line: 5, reason: "内容が空です" },
      { line: 6, reason: "金額を読めません" },
      { line: 7, reason: "金額が空です" },
      { line: 9, reason: "金額が大きすぎます" },
      { line: 10, reason: "列が足りません" },
    ]);
  });

  it("引用の中の改行を含む行の番号は、その行が始まる行", () => {
    const text = ["日付,内容,金額", '2026/10/01,"a\nb",100', "合計,,"].join("\n");
    const { rows, unreadable } = read(text, SIMPLE, OPTS);
    expect(rows[0]?.content).toBe("a\nb");
    expect(unreadable).toEqual([{ line: 4, reason: "日付を読めません" }]);
  });

  it("口座名の列が空の行は「口座名が空です」", () => {
    const mapping: StatementColumnMapping = {
      ...SIMPLE,
      columns: { date: 0, content: 1, amount: 2, accountName: 3 },
    };
    const text = "日付,内容,金額,口座\n2026/10/01,A,100,\n2026/10/02,B,100,銀行";
    const { rows, unreadable } = read(text, mapping, { year: 2026 });
    expect(unreadable).toEqual([{ line: 2, reason: "口座名が空です" }]);
    expect(rows.map((r) => r.accountName)).toEqual(["銀行"]);
  });

  it("2 列: 両方に値 / 両方が空か 0 / 読めない値", () => {
    const text = [
      "日付,内容,出金,入金",
      "2026/10/01,A,100,200", // 2
      "2026/10/02,B,,", // 3
      "2026/10/03,C,0,0", // 4
      "2026/10/04,D,x,100", // 5
      "2026/10/05,E,100,0", // 6
      "2026/10/06,F,,300", // 7
      "2026/10/07,G,-400,", // 8（出金の列の負の値は入金）
      "2026/10/08,H,0,1000000000000", // 9
    ].join("\n");
    const { rows, unreadable } = read(text, SPLIT, OPTS);
    expect(unreadable).toEqual([
      { line: 2, reason: "出金と入金の両方に値があります" },
      { line: 3, reason: "金額が空です" },
      { line: 4, reason: "金額が空です" },
      { line: 5, reason: "金額を読めません" },
      { line: 9, reason: "金額が大きすぎます" },
    ]);
    expect(rows.map((r) => [r.content, r.amount])).toEqual([
      ["E", -100],
      ["F", 300],
      ["G", 400],
    ]);
  });

  it("すべて読めなければ STATEMENT_TABLE_UNREADABLE（details.unreadable）", () => {
    const e = readErr("日付,内容,金額\n合計,,\n小計", SIMPLE);
    expect(e.code).toBe("STATEMENT_TABLE_UNREADABLE");
    expect(e.details).toEqual({
      unreadable: [
        { line: 2, reason: "日付を読めません" },
        { line: 3, reason: "列が足りません" },
      ],
    });
    expect(readErr("", SIMPLE).code).toBe("STATEMENT_TABLE_UNREADABLE");
    expect(readErr("日付,内容,金額\n", SIMPLE).code).toBe("STATEMENT_TABLE_UNREADABLE");
  });
});

describe("readStatementTable: 金額の向き・見出し・前置き", () => {
  it("1 列: outflow_positive は符号を反転する", () => {
    const text = "日付,内容,金額\n2026/10/01,A,100\n2026/10/02,B,-30";
    const flipped = read(text, { ...SIMPLE, amountSign: "outflow_positive" }, OPTS);
    expect(flipped.rows.map((r) => r.amount)).toEqual([-100, 30]);
    expect(read(text, SIMPLE, OPTS).rows.map((r) => r.amount)).toEqual([100, -30]);
  });

  it("headerRow は元のテキストの行の番号（0 起点）。それより前の行は読まない", () => {
    const text = "2026/09/30,前置きに見える行,999\n日付,内容,金額\n2026/10/01,A,100";
    const { rows } = read(text, { ...SIMPLE, headerRow: 1 }, OPTS);
    expect(rows.map((r) => r.content)).toEqual(["A"]);
  });

  it("headerRow が null なら全行がデータ", () => {
    const { rows } = read(
      "2026/10/01,A,100\n2026/10/02,B,-5",
      { ...SIMPLE, headerRow: null },
      OPTS,
    );
    expect(rows).toHaveLength(2);
  });

  it("区切り文字: タブ・セミコロン。CRLF・CR の行末。末尾の改行あり・なし", () => {
    const tab = read(
      "日付\t内容\t金額\r\n2026/10/01\tA\t1,000\r\n",
      { ...SIMPLE, delimiter: "\t" },
      OPTS,
    );
    expect(tab.rows[0]?.amount).toBe(1000);
    const semi = read("日付;内容;金額\r2026/10/01;A;1,000", { ...SIMPLE, delimiter: ";" }, OPTS);
    expect(semi.rows[0]?.amount).toBe(1000);
  });

  it("年のない日付は year を使う", () => {
    const text = "日付,内容,金額\n10/01(木),A,100";
    expect(read(text, SIMPLE, { year: 2026, fixedAccountName: "x" }).rows[0]?.date).toBe(
      "2026-10-01",
    );
    expect(read(text, SIMPLE, { year: 2025, fixedAccountName: "x" }).rows[0]?.date).toBe(
      "2025-10-01",
    );
  });

  it("内容は前後の空白を除くが、NFKC しない。分類・メモが空なら項目を持たない", () => {
    const text = "日付,内容,金額,メモ\n2026/10/01,  ｻﾝﾌﾟﾙ  ,100, ";
    const { rows } = read(
      text,
      { ...SIMPLE, columns: { date: 0, content: 1, amount: 2, memo: 3 } },
      OPTS,
    );
    expect(rows[0]).toEqual({
      accountName: "口座A",
      date: "2026-10-01",
      content: "ｻﾝﾌﾟﾙ",
      amount: 100,
      transferFlag: false,
    });
  });

  it("振替の印: 1・○・◯・true・yes・はい・振替（大小文字・全角を問わない）だけが真", () => {
    const mapping: StatementColumnMapping = {
      ...SIMPLE,
      columns: { date: 0, content: 1, amount: 2, transferFlag: 3 },
    };
    const marks = ["1", "○", "◯", "TRUE", "Yes", "はい", "振替", "０", "0", "", "いいえ"];
    const text = `日付,内容,金額,振替\n${marks.map((m, i) => `2026/10/01,R${i},100,${m}`).join("\n")}`;
    const { rows } = read(text, mapping, OPTS);
    expect(rows.map((r) => r.transferFlag)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
  });
});

describe("readStatementTable: 口座名（INV-50 の後半）", () => {
  it("accountName の役割がなければ、全行の口座は fixedAccountName", () => {
    const { rows } = read("日付,内容,金額\n2026/10/01,A,1\n2026/10/02,B,2", SIMPLE, {
      year: 2026,
      fixedAccountName: "サンプル銀行",
    });
    expect(rows.map((r) => r.accountName)).toEqual(["サンプル銀行", "サンプル銀行"]);
  });

  it("accountName の役割も fixedAccountName もなければ STATEMENT_MAPPING_INVALID", () => {
    const e = readErr("日付,内容,金額\n2026/10/01,A,1", SIMPLE, { year: 2026 });
    expect(e.code).toBe("STATEMENT_MAPPING_INVALID");
    expect(
      readErr("日付,内容,金額\n2026/10/01,A,1", SIMPLE, { year: 2026, fixedAccountName: " " }).code,
    ).toBe("STATEMENT_MAPPING_INVALID");
  });

  it("accountName の役割があれば、その列の値（fixedAccountName は使わない）", () => {
    const mapping: StatementColumnMapping = {
      ...SIMPLE,
      columns: { date: 0, content: 1, amount: 2, accountName: 3 },
    };
    const { rows } = read("日付,内容,金額,口座\n2026/10/01,A,1,銀行X", mapping, {
      year: 2026,
      fixedAccountName: "無視される",
    });
    expect(rows[0]?.accountName).toBe("銀行X");
  });
});

describe("readStatementTable: 対応の検査", () => {
  it("列の番号が表の列数を超えれば STATEMENT_MAPPING_INVALID", () => {
    const text = "日付,内容,金額\n2026/10/01,A,1";
    const e = readErr(text, { ...SIMPLE, columns: { date: 0, content: 1, amount: 3 } }, OPTS);
    expect(e.code).toBe("STATEMENT_MAPPING_INVALID");
  });

  it("対応が Zod の検査に通らなければ（date がない・同じ列を 2 役割）STATEMENT_MAPPING_INVALID", () => {
    const text = "日付,内容,金額\n2026/10/01,A,1";
    expect(readErr(text, { ...SIMPLE, columns: { content: 1, amount: 2 } }).code).toBe(
      "STATEMENT_MAPPING_INVALID",
    );
    expect(readErr(text, { ...SIMPLE, columns: { date: 0, content: 0, amount: 2 } }).code).toBe(
      "STATEMENT_MAPPING_INVALID",
    );
  });
});
