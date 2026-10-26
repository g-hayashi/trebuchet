import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MFME_COLUMNS, parseMfmePaste } from "../../src/statements/paste.ts";
import { readTextFixture } from "../fixtures/mfme/load.ts";
import { formatMfmePaste, pastedRowArb } from "../statements-arbitraries.ts";

// 006 R2。MF ME の貼り付け（タブ区切り）の読み取り

const parsed = (text: string, year = 2026) => {
  const r = parseMfmePaste(text, year);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

describe("parseMfmePaste（paste-basic.txt）", () => {
  const { rows, unreadable } = parsed(readTextFixture("paste-basic.txt"));

  it("見出しの名前で列を対応づけ、9 行を読む", () => {
    expect(rows).toHaveLength(9);
    expect(rows[0]).toEqual({
      accountName: "サンプル銀行",
      date: "2026-10-01",
      content: "ショップ001",
      amount: -1200,
      categoryMajor: "食費",
      categoryMinor: "食料品",
      transferFlag: false,
    });
  });

  it("入金は正、メモを読み、`−`（U+2212）も負の金額として読む", () => {
    expect(rows[1]).toMatchObject({ amount: 330_000, memo: "請求書払い", categoryMajor: "収入" });
    expect(rows[2]).toMatchObject({ amount: 1_500, accountName: "テストカードA" });
    expect(rows[5]).toMatchObject({ amount: -20_000, transferFlag: true });
  });

  it("振替の印を読む。カードの引落は引落元・引落先の 2 行が印つきで残る", () => {
    expect(rows.filter((r) => r.transferFlag).map((r) => r.accountName)).toEqual([
      "サンプル銀行",
      "テストカードA",
      "サンプル銀行",
      "テスト現金",
    ]);
  });

  it("同じ口座・日付・金額・内容の行は 2 行とも残す", () => {
    expect(rows[7]).toEqual(rows[8]);
  });

  it("3 口座が混ざる", () => {
    expect(new Set(rows.map((r) => r.accountName))).toEqual(
      new Set(["サンプル銀行", "テストカードA", "テスト現金"]),
    );
  });

  it("合計の行は理由つきの読めない行になる（行番号は 1 始まり。空行は数えない）", () => {
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]?.line).toBe(11);
    expect(unreadable[0]?.reason).toContain("日付");
  });

  it("externalId は持たない（貼り付けは ID を持たない）", () => {
    for (const r of rows) expect(r.externalId).toBeUndefined();
  });
});

describe("parseMfmePaste（見出しなし・年・列の順）", () => {
  it("見出しがなければ既定の並び（日付・内容・金額・保有金融機関・大項目・中項目・メモ・振替）", () => {
    const { rows, unreadable } = parsed(readTextFixture("paste-no-header.txt"));
    expect(unreadable).toEqual([]);
    expect(rows.map((r) => [r.date, r.amount, r.accountName])).toEqual([
      ["2026-10-01", -1200, "サンプル銀行"],
      ["2026-10-02", 330_000, "サンプル銀行"],
      ["2026-10-08", -3980, "テスト現金"],
    ]);
    expect(rows[1]?.memo).toBe("請求書払い");
  });

  it("MM/DD(曜) に渡した年を補う", () => {
    const text = readTextFixture("paste-no-header.txt");
    expect(parsed(text, 2025).rows[0]?.date).toBe("2025-10-01");
  });

  it("見出しの列の並びが違っても、名前で対応づける。読まない列は無視する", () => {
    const text = [
      ["保有金融機関", "金額（円）", "削除", "内容", "日付"].join("\t"),
      ["サンプル銀行", "1,000", "0", "ショップ001", "03/04(水)"].join("\t"),
    ].join("\n");
    expect(parsed(text).rows).toEqual([
      {
        accountName: "サンプル銀行",
        date: "2026-03-04",
        content: "ショップ001",
        amount: 1000,
        transferFlag: false,
      },
    ]);
  });

  it("YYYY/MM/DD・MM/DD の日付も読む", () => {
    const text = ["2026/03/04\tA店\t-100\t口座1", "3/5\tB店\t-200\t口座1"].join("\n");
    expect(parsed(text).rows.map((r) => r.date)).toEqual(["2026-03-04", "2026-03-05"]);
  });

  it("対応表は 1 か所（MFME_COLUMNS）に置く", () => {
    expect(Object.keys(MFME_COLUMNS).sort()).toEqual(
      [
        "accountName",
        "amount",
        "categoryMajor",
        "categoryMinor",
        "content",
        "date",
        "memo",
        "transferFlag",
      ].sort(),
    );
  });
});

describe("parseMfmePaste（読めない行）", () => {
  const header = ["日付", "内容", "金額（円）", "保有金融機関"].join("\t");
  const row = (...cells: string[]) => cells.join("\t");

  it("金額の書式: `,` `−` `-` `+` を読み、小数・文字は読めない行にする", () => {
    const { rows, unreadable } = parsed(
      [
        header,
        row("01/01(木)", "a", "1,234", "口座1"),
        row("01/02(金)", "b", "-1,234", "口座1"),
        row("01/03(土)", "c", "−5,678", "口座1"),
        row("01/04(日)", "d", "+500", "口座1"),
        row("01/05(月)", "e", "12.5", "口座1"),
        row("01/06(火)", "f", "abc", "口座1"),
        row("01/07(水)", "g", "", "口座1"),
      ].join("\n"),
    );
    expect(rows.map((r) => r.amount)).toEqual([1234, -1234, -5678, 500]);
    expect(unreadable.map((u) => u.line)).toEqual([6, 7, 8]);
    for (const u of unreadable) expect(u.reason).toContain("金額");
  });

  it("実在しない日付・内容や口座が空・列が足りない行は理由つきで返す", () => {
    const { rows, unreadable } = parsed(
      [
        header,
        row("02/30(月)", "a", "100", "口座1"),
        row("01/02(金)", "", "100", "口座1"),
        row("01/03(土)", "c", "100", ""),
        row("01/04(日)", "d"),
        row("01/05(月)", "e", "100", "口座1"),
      ].join("\n"),
    );
    expect(rows).toHaveLength(1);
    expect(unreadable.map((u) => u.line)).toEqual([2, 3, 4, 5]);
    expect(unreadable.map((u) => u.reason)).toEqual([
      expect.stringContaining("日付"),
      expect.stringContaining("内容"),
      expect.stringContaining("保有金融機関"),
      expect.stringContaining("列"),
    ]);
  });

  it("0 円の行も読む（候補は US2 で作らない）", () => {
    expect(parsed([header, row("01/01(木)", "a", "0", "口座1")].join("\n")).rows[0]?.amount).toBe(
      0,
    );
  });
});

describe("parseMfmePaste（STATEMENT_PASTE_UNREADABLE）", () => {
  const failure = (text: string) => {
    const r = parseMfmePaste(text, 2026);
    if (r.ok) throw new Error("失敗するはず");
    return r.error;
  };

  it("必須の列（日付・内容・金額・保有金融機関）が欠ければ missingColumns つきで失敗する", () => {
    const e = failure(`${["日付", "内容", "保有金融機関"].join("\t")}\n01/01(木)\ta\t口座1`);
    expect(e.code).toBe("STATEMENT_PASTE_UNREADABLE");
    expect(e.details?.missingColumns).toEqual(["金額（円）"]);
  });

  it("1 行も読めなければ unreadable つきで失敗する", () => {
    const e = failure("あいうえお\nかきくけこ");
    expect(e.code).toBe("STATEMENT_PASTE_UNREADABLE");
    expect(e.details?.unreadable).toHaveLength(2);
  });

  it("空のテキストは失敗する", () => {
    expect(failure("").code).toBe("STATEMENT_PASTE_UNREADABLE");
    expect(failure("\n  \n").code).toBe("STATEMENT_PASTE_UNREADABLE");
  });

  it("見出しだけで行がなければ失敗する", () => {
    const e = failure("日付\t内容\t金額（円）\t保有金融機関\n");
    expect(e.code).toBe("STATEMENT_PASTE_UNREADABLE");
  });
});

describe("parseMfmePaste（往復）", () => {
  it("貼り付けのテキストにした行を、同じ行として読み直す（見出しあり・なし）", () => {
    fc.assert(
      fc.property(
        fc.array(pastedRowArb, { minLength: 1, maxLength: 10 }),
        fc.boolean(),
        (rows, header) => {
          const text = formatMfmePaste(rows, { header });
          const r = parseMfmePaste(text, 2026);
          expect(r.ok).toBe(true);
          if (!r.ok) return;
          expect(r.value.unreadable).toEqual([]);
          expect(r.value.rows).toEqual(rows);
        },
      ),
    );
  });
});
