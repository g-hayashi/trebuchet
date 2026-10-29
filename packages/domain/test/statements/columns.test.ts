import { describe, expect, it } from "vitest";
import { decodeText, parseDelimitedLines } from "../../src/import/csv.ts";
import {
  COLUMN_ROLE_NAMES,
  normalizeHeaderName,
  suggestColumns,
} from "../../src/statements/columns.ts";
import { ALL_STATEMENT_FIXTURES, CUSTOM_HEADER } from "../fixtures/statements/expected.ts";
import { readStatementFixture } from "../fixtures/statements/load.ts";

// 007/R4。見出しの辞書と列の案

describe("normalizeHeaderName", () => {
  it("NFKC・空白・括弧書きを除き、英字は小文字にする", () => {
    expect(normalizeHeaderName("金額（円）")).toBe("金額");
    expect(normalizeHeaderName("　ご 利用 日 ")).toBe("ご利用日");
    expect(normalizeHeaderName("Ａｍｏｕｎｔ (JPY)")).toBe("amount");
    expect(normalizeHeaderName("ＩＤ")).toBe("id");
  });
});

describe("COLUMN_ROLE_NAMES", () => {
  it("R4 の役割がすべてあり、正規化した名前はどの役割とも重ならない", () => {
    expect(Object.keys(COLUMN_ROLE_NAMES).sort()).toEqual(
      [
        "date",
        "content",
        "amount",
        "outflow",
        "inflow",
        "accountName",
        "categoryMajor",
        "categoryMinor",
        "memo",
        "externalId",
        "transferFlag",
      ].sort(),
    );
    const seen = new Map<string, string>();
    for (const [role, names] of Object.entries(COLUMN_ROLE_NAMES)) {
      for (const name of names) {
        const key = normalizeHeaderName(name);
        expect(
          seen.get(key),
          `${name} が ${seen.get(key)} と ${role} の両方にある`,
        ).toBeUndefined();
        seen.set(key, role);
      }
    }
  });

  it("残高は役割に持たない", () => {
    const all = Object.values(COLUMN_ROLE_NAMES).flat().map(normalizeHeaderName);
    expect(all).not.toContain("残高");
    expect(all).not.toContain("差引残高");
  });
});

describe("suggestColumns", () => {
  it("MF ME の見出しは列を選ばずに案がそろう", () => {
    expect(
      suggestColumns([
        "計算対象",
        "日付",
        "内容",
        "金額（円）",
        "保有金融機関",
        "大項目",
        "中項目",
        "メモ",
        "振替",
        "ID",
      ]),
    ).toEqual({
      date: 1,
      content: 2,
      amount: 3,
      accountName: 4,
      categoryMajor: 5,
      categoryMinor: 6,
      memo: 7,
      transferFlag: 8,
      externalId: 9,
    });
  });

  it("銀行の出金・入金の 2 列。残高は案にしない", () => {
    expect(suggestColumns(["取引日", "摘要", "出金額", "入金額", "残高"])).toEqual({
      date: 0,
      content: 1,
      outflow: 2,
      inflow: 3,
    });
  });

  it("完全一致だけを当てる（「お支払金額」は amount、「お支払」は outflow）", () => {
    expect(suggestColumns(["お支払金額"])).toEqual({ amount: 0 });
    expect(suggestColumns(["お支払"])).toEqual({ outflow: 0 });
    expect(suggestColumns(["支払区分", "ご利用日メモ"])).toEqual({});
  });

  it("全角・空白・括弧書き・英字の大小を無視する", () => {
    expect(suggestColumns(["Ｄａｔｅ", " 利用 金額 （円） ", "DESCRIPTION", "Credit"])).toEqual({
      date: 0,
      amount: 1,
      content: 2,
      inflow: 3,
    });
  });

  it("同じ役割に 2 列が当たれば、左の列だけを案にする", () => {
    expect(suggestColumns(["内容", "日付", "摘要", "取引日", "金額", "利用金額"])).toEqual({
      content: 0,
      date: 1,
      amount: 4,
    });
  });

  it("どれも当たらなければ空", () => {
    expect(suggestColumns(["a", "b"])).toEqual({});
    expect(suggestColumns([])).toEqual({});
  });

  it("辞書の名前はすべて自分の役割に当たる", () => {
    for (const [role, names] of Object.entries(COLUMN_ROLE_NAMES)) {
      for (const name of names) {
        expect(suggestColumns([name]), name).toEqual({ [role]: 0 });
      }
    }
  });

  it("フィクスチャの見出しの案は、正しい対応の部分集合（残高・計算対象は読まない）", () => {
    for (const f of ALL_STATEMENT_FIXTURES) {
      if (f.mapping.headerRow === null || f === CUSTOM_HEADER) continue;
      const { text } = decodeText(readStatementFixture(f.file));
      const lines = parseDelimitedLines(text, f.mapping.delimiter);
      const header = lines.find((l) => l.line - 1 === f.mapping.headerRow)?.cells ?? [];
      const suggested = suggestColumns(header);
      expect(suggested, f.file).toEqual(
        Object.fromEntries(
          Object.entries(f.mapping.columns).filter(([role]) => role !== "amountSign"),
        ),
      );
    }
  });

  it("独自の見出し（custom-header.csv）は辞書では案が出ない", () => {
    const { text } = decodeText(readStatementFixture(CUSTOM_HEADER.file));
    const header = parseDelimitedLines(text, ",")[0]?.cells ?? [];
    expect(suggestColumns(header)).toEqual({});
  });
});
