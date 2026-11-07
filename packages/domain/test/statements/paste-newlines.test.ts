import type { StatementColumnMapping } from "@trebuchet/schema";
import { describe, expect, it } from "vitest";
import {
  detectTableLayout,
  parseStatementDate,
  readStatementTable,
} from "../../src/statements/table.ts";

// 007/R16: ブラウザの表をコピーすると、セルの中の改行が引用符なしの改行になる。タブ区切りの物理行を「件」にまとめ、
// 見出しも 1 行にまとめてから、区切り文字・見出し・値を読む。例の形は貼り付けの実例に合わせた合成（店名・番号は架空）

const tsv = (...lines: string[]) => lines.join("\n");

/** 例 1（カード）: 見出しのセルの中に改行。データは 1 行 1 件（外貨は後ろに 4 セル）。最後に日付のない行 */
const CARD_PASTE = tsv(
  "ご利用日\tご利用店名 ※\tカード\t支払区分\t分割",
  "回数\t支払",
  "予定月\tご利用金額\t（お支払い総額）\t（内手数料）",
  "現地通貨額\t略称\t換算レート\t換算日",
  "26/10/31\tテスト商店A\tご本人\tリボ払い\t\t26/11\t4,100\t",
  "26/10/26\tTEST ONLINE\tご本人\tリボ払い\t\t26/11\t1,800\t\t11.22\tUSD\t163.034\t10/26",
  "26/10/20\tテスト商店B\tご本人\tリボ払い\t\t26/11\t3,000\t",
  "26/10/18\tテスト商店C\tご本人\tリボ払い\t\t26/11\t860\t",
  "26/10/12\tテスト商店D\tご本人\tリボ払い\t\t26/11\t2,450\t",
  "リボ払いお支払い\tご本人\t\t\t26/11\t5,001",
);

/** 例 2（カード）: 1 件が 3 物理行（年だけの行、日付から始まる行、続きの行）。見出しは 8 物理行 */
const CARD_THREE_LINES = tsv(
  "ご利用",
  "年月日\tカード番号\tご利用箇所\tご利用額",
  "（割引後額）\t海外利用\t支払方法（回数）\t支払方法",
  "変更",
  "現地",
  "通貨額\t通貨",
  "略称\t換算",
  "レート",
  "2026",
  "10/09\t****-****-****-1234\t駅名　オートチャージ（モバイル）\t5,000",
  "(5,000)\t\tショッピング１回払い\t\t\t",
  "2026",
  "10/12\t****-****-****-1234\tテスト書店\t1,200",
  "(1,200)\t\tショッピング１回払い\t\t\t",
  "2026",
  "10/20\t****-****-****-1234\tテスト食堂\t800",
  "(800)\t\tショッピング１回払い\t\t\t",
);

const readCard = (text: string, mapping: StatementColumnMapping) =>
  readStatementTable(text, mapping, { year: 2026, fixedAccountName: "テストカード" });

describe("例 1: 見出しのセルの中の改行（外貨の行・日付のない行つき）", () => {
  it("タブ区切り・見出しは 1 行にまとまる・辞書の案・符号の案・列数は件の最頻値", () => {
    const r = detectTableLayout(CARD_PASTE);
    if (!r.ok) throw new Error(r.error.message);
    const layout = r.value;
    expect(layout.delimiter).toBe("\t");
    expect(layout.headerRow).toBe(0);
    expect(layout.header?.[0]).toBe("ご利用日");
    expect(layout.header?.[6]).toBe("ご利用金額");
    expect(layout.header).toHaveLength(12);
    expect(layout.columnCount).toBe(8);
    expect(layout.suggestedColumns).toEqual({ date: 0, content: 1, amount: 6 });
    expect(layout.suggestedAmountSign).toBe("outflow_positive");
    // 5 件 + 日付のない行（つなぐと列数が超えるので独立した行）
    expect(layout.rowCount).toBe(6);
    expect(layout.needsYear).toBe(false);
  });

  it("読む: 外貨の行も読み、日付のない行は元のテキストの行の番号つきで読めない行になる", () => {
    const mapping: StatementColumnMapping = {
      delimiter: "\t",
      headerRow: 0,
      columns: { date: 0, content: 1, amount: 6 },
      amountSign: "outflow_positive",
    };
    const r = readCard(CARD_PASTE, mapping);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.rows.map((x) => [x.date, x.content, x.amount])).toEqual([
      ["2026-10-31", "テスト商店A", -4100],
      ["2026-10-26", "TEST ONLINE", -1800],
      ["2026-10-20", "テスト商店B", -3000],
      ["2026-10-18", "テスト商店C", -860],
      ["2026-10-12", "テスト商店D", -2450],
    ]);
    // 日付のない行は、前の件につなげない（つなぐと列数が超える）ので、独立した読めない行（列数 6 < 必要な 7）
    expect(r.value.unreadable).toEqual([{ line: 10, reason: "列が足りません" }]);
  });
});

describe("例 2: 1 件が 3 物理行（年の行・続きの行）", () => {
  it("カンマではなくタブが選ばれ、年の行と日付の行が 1 つの日付セルになる", () => {
    const r = detectTableLayout(CARD_THREE_LINES);
    if (!r.ok) throw new Error(r.error.message);
    const layout = r.value;
    expect(layout.delimiter).toBe("\t");
    expect(layout.headerRow).toBe(0);
    expect(layout.header?.[0]).toBe("ご利用\n年月日");
    expect(layout.header?.[3]).toBe("ご利用額\n（割引後額）");
    expect(layout.columnCount).toBe(9);
    expect(layout.rowCount).toBe(3);
    expect(layout.sampleRows[0]?.[0]).toBe("2026/10/09");
    expect(layout.sampleRows[0]?.[2]).toBe("駅名　オートチャージ（モバイル）");
    expect(layout.sampleRows[0]?.[3]).toBe("5,000\n(5,000)");
    expect(layout.suggestedColumns).toEqual({ date: 0, content: 2, amount: 3 });
    expect(layout.suggestedAmountSign).toBe("outflow_positive");
    expect(layout.needsYear).toBe(false);
  });

  it("読む: 金額は割引前の 1 行目（5,000）を読む。行の番号は件の最初の物理行（年の行）", () => {
    const mapping: StatementColumnMapping = {
      delimiter: "\t",
      headerRow: 0,
      columns: { date: 0, content: 2, amount: 3 },
      amountSign: "outflow_positive",
    };
    const r = readCard(CARD_THREE_LINES, mapping);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.rows.map((x) => [x.date, x.amount])).toEqual([
      ["2026-10-09", -5000],
      ["2026-10-12", -1200],
      ["2026-10-20", -800],
    ]);
    expect(r.value.unreadable).toEqual([]);
  });

  it("detect と read で件の数が同じ（見出しの行の番号を使って読み直せる）", () => {
    const d = detectTableLayout(CARD_THREE_LINES);
    if (!d.ok) throw new Error(d.error.message);
    const r = readCard(CARD_THREE_LINES, {
      delimiter: "\t",
      headerRow: d.value.headerRow,
      columns: { date: 0, content: 2, amount: 3 },
      amountSign: "inflow_positive",
    });
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.rows.length + r.value.unreadable.length).toBe(d.value.rowCount);
  });
});

describe("まとめない場合", () => {
  it("引用つきの CSV は今のまま（セル内の改行は引用の中）", () => {
    const text = tsv("日付,内容,金額", '2026/10/01,"A', 'B",-100', "2026/10/02,C,-200");
    const r = detectTableLayout(text);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.delimiter).toBe(",");
    expect(r.value.rowCount).toBe(2);
    expect(r.value.sampleRows[0]).toEqual(["2026/10/01", "A\nB", "-100"]);
  });

  it("件が列数の最頻値に達していれば、日付のない行は続けず独立した行（合計の行が金額を壊さない）", () => {
    const text = tsv(
      "日付\t内容\t金額",
      "2026/10/01\tA\t-100",
      "2026/10/02\tB\t-200",
      "合計\t-300",
    );
    const r = readStatementTable(
      text,
      {
        delimiter: "\t",
        headerRow: 0,
        columns: { date: 0, content: 1, amount: 2 },
        amountSign: "inflow_positive",
      },
      { year: 2026, fixedAccountName: "X" },
    );
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.rows).toHaveLength(2);
    expect(r.value.unreadable).toEqual([{ line: 4, reason: "列が足りません" }]);
  });

  it("見出しも合計の行も日付の行と同じ幅の 1 行 1 件の表は、日付のない行を見出しにも件にも続けない", () => {
    const text = tsv(
      "日付\t保有金融機関\t内容\t金額",
      "合計\tテスト銀行\tA\t1",
      "合計\tテスト銀行\tA\t1",
      "2026/10/01\tテスト銀行\tA\t1",
      "合計\tテスト銀行\tA\t1",
      "2026/10/02\tテスト銀行\tB\t2",
    );
    const mapping: StatementColumnMapping = {
      delimiter: "\t",
      headerRow: 0,
      columns: { date: 0, accountName: 1, content: 2, amount: 3 },
      amountSign: "inflow_positive",
    };
    const r = readStatementTable(text, mapping, { year: 2026 });
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.rows).toHaveLength(2);
    expect(r.value.unreadable.map((u) => u.line)).toEqual([2, 3, 5]);
  });

  it("日付で始まる行がなければ（MF ME など）まとめない", () => {
    const text = tsv("計算対象\t日付\t内容\t金額", "1\t10/01\tA\t-100", "1\t10/02\tB\t-200");
    const r = detectTableLayout(text);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.headerRow).toBe(0);
    expect(r.value.rowCount).toBe(2);
    expect(r.value.columnCount).toBe(4);
  });

  it("見出しが 1 行で最頻値の列数なら、前置きの行を見出しにまとめない", () => {
    const text = tsv(
      "ご利用明細",
      "口座\t1234",
      "日付\t内容\t金額",
      "2026/10/01\tA\t-100",
      "2026/10/02\tB\t-200",
    );
    const r = detectTableLayout(text);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.headerRow).toBe(2);
    expect(r.value.header).toEqual(["日付", "内容", "金額"]);
  });
});

describe("日付 YY/MM/DD", () => {
  it("年が 2 桁の YY/MM/DD は 2000 年代として読む", () => {
    expect(parseStatementDate("26/10/31", 2000)).toBe("2026-10-31");
    expect(parseStatementDate("26.10.31", 2000)).toBe("2026-10-31");
    expect(parseStatementDate("26/11", 2026)).toBeUndefined();
    expect(parseStatementDate("26/13/01", 2026)).toBeUndefined();
  });
});
