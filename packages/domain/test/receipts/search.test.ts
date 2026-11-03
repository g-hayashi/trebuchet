import { describe, expect, it } from "vitest";
import {
  escapeLike,
  matchesReceiptQuery,
  normalizeReceiptText,
} from "../../src/receipts/search.ts";
import { makeReceiptQuery, makeReceiptRow } from "../receipt-setup.ts";

// T004: 検索の純関数（research R4、data-model §2.3）

describe("normalizeReceiptText", () => {
  it("NFKC → 大文字 → 空白を除く", () => {
    expect(normalizeReceiptText("Ａｂｃ　ｄｅｆ")).toBe("ABCDEF");
    expect(normalizeReceiptText("ｶﾌｪ ﾄﾞﾄｰﾙ")).toBe("カフェドトール");
    expect(normalizeReceiptText(" a\tb\nc 　d ")).toBe("ABCD");
    expect(normalizeReceiptText("ｱｲｳ")).toBe("アイウ");
  });

  it("数字は置き換えない（006 の normalizeContent と違う）", () => {
    expect(normalizeReceiptText("店 12 号")).toBe("店12号");
    expect(normalizeReceiptText("１２")).toBe("12");
  });

  it("空白だけなら空", () => {
    expect(normalizeReceiptText(" 　\t")).toBe("");
  });
});

describe("escapeLike", () => {
  it("%・_・\\ を \\ で逃がす", () => {
    expect(escapeLike("50%")).toBe("50\\%");
    expect(escapeLike("a_b")).toBe("a\\_b");
    expect(escapeLike("a\\b")).toBe("a\\\\b");
    expect(escapeLike("%_\\")).toBe("\\%\\_\\\\");
  });

  it("ほかの文字はそのまま", () => {
    expect(escapeLike("ABC あ")).toBe("ABC あ");
    expect(escapeLike("")).toBe("");
  });
});

describe("matchesReceiptQuery", () => {
  const receipt = makeReceiptRow({
    transactionDate: "2026-10-20",
    amount: 1100,
    partnerName: "Ｃａｆｅ　ドトール",
    category: "paper_scan",
  });

  it("条件がなければ削除済みでない行は合う", () => {
    expect(matchesReceiptQuery(receipt, "none", makeReceiptQuery())).toBe(true);
  });

  it("取引年月日の範囲は両端を含み、未入力の行は外れる", () => {
    const q = (dateFrom?: string, dateTo?: string) =>
      makeReceiptQuery({
        ...(dateFrom === undefined ? {} : { dateFrom }),
        ...(dateTo === undefined ? {} : { dateTo }),
      });
    expect(matchesReceiptQuery(receipt, "none", q("2026-10-20", "2026-10-20"))).toBe(true);
    expect(matchesReceiptQuery(receipt, "none", q("2026-10-21"))).toBe(false);
    expect(matchesReceiptQuery(receipt, "none", q(undefined, "2026-10-19"))).toBe(false);
    const noDate = makeReceiptRow({ transactionDate: null });
    expect(matchesReceiptQuery(noDate, "none", q("2026-01-01"))).toBe(false);
    expect(matchesReceiptQuery(noDate, "none", q(undefined, "2026-12-31"))).toBe(false);
  });

  it("金額の範囲は両端を含み、未入力の行は外れる", () => {
    const q = (amountMin?: number, amountMax?: number) =>
      makeReceiptQuery({
        ...(amountMin === undefined ? {} : { amountMin }),
        ...(amountMax === undefined ? {} : { amountMax }),
      });
    expect(matchesReceiptQuery(receipt, "none", q(1100, 1100))).toBe(true);
    expect(matchesReceiptQuery(receipt, "none", q(1101))).toBe(false);
    expect(matchesReceiptQuery(receipt, "none", q(undefined, 1099))).toBe(false);
    const noAmount = makeReceiptRow({ amount: null });
    expect(matchesReceiptQuery(noAmount, "none", q(0))).toBe(false);
    expect(matchesReceiptQuery(noAmount, "none", q(undefined, 999_999))).toBe(false);
  });

  it("取引先は全角・半角・大文字小文字・空白を区別しない部分一致", () => {
    const q = (partner: string) => makeReceiptQuery({ partner });
    expect(matchesReceiptQuery(receipt, "none", q("cafe"))).toBe(true);
    expect(matchesReceiptQuery(receipt, "none", q("ＣＡＦＥ"))).toBe(true);
    expect(matchesReceiptQuery(receipt, "none", q("e ド"))).toBe(true);
    expect(matchesReceiptQuery(receipt, "none", q("ﾄﾞﾄｰﾙ"))).toBe(true);
    expect(matchesReceiptQuery(receipt, "none", q("スタバ"))).toBe(false);
    expect(matchesReceiptQuery(makeReceiptRow({ partnerName: null }), "none", q("a"))).toBe(false);
  });

  it("取引先の %・_・\\ はそのままの文字として比べる", () => {
    const percent = makeReceiptRow({ partnerName: "100%店" });
    const other = makeReceiptRow({ partnerName: "100円店" });
    const q = (partner: string) => makeReceiptQuery({ partner });
    expect(matchesReceiptQuery(percent, "none", q("%"))).toBe(true);
    expect(matchesReceiptQuery(other, "none", q("%"))).toBe(false);
    expect(matchesReceiptQuery(makeReceiptRow({ partnerName: "a_b" }), "none", q("_"))).toBe(true);
    expect(matchesReceiptQuery(makeReceiptRow({ partnerName: "axb" }), "none", q("a_b"))).toBe(
      false,
    );
    expect(matchesReceiptQuery(makeReceiptRow({ partnerName: "a\\b" }), "none", q("\\"))).toBe(
      true,
    );
    expect(matchesReceiptQuery(makeReceiptRow({ partnerName: "ab" }), "none", q("\\"))).toBe(false);
  });

  it("区分は一致するものだけ", () => {
    expect(matchesReceiptQuery(receipt, "none", makeReceiptQuery({ category: "paper_scan" }))).toBe(
      true,
    );
    expect(matchesReceiptQuery(receipt, "none", makeReceiptQuery({ category: "electronic" }))).toBe(
      false,
    );
  });

  it("missing: true は取引年月日・金額・取引先のどれかが未入力の行だけ。false は条件にしない", () => {
    const full = receipt;
    const q = makeReceiptQuery({ missing: true });
    expect(matchesReceiptQuery(full, "none", q)).toBe(false);
    expect(matchesReceiptQuery(makeReceiptRow({ transactionDate: null }), "none", q)).toBe(true);
    expect(matchesReceiptQuery(makeReceiptRow({ amount: null }), "none", q)).toBe(true);
    expect(matchesReceiptQuery(makeReceiptRow({ partnerName: null }), "none", q)).toBe(true);
    expect(
      matchesReceiptQuery(full, "none", makeReceiptQuery({ missing: false })) &&
        matchesReceiptQuery(
          makeReceiptRow({ amount: null }),
          "none",
          makeReceiptQuery({ missing: false }),
        ),
    ).toBe(true);
  });

  it("結びつきの状態は渡された値で比べる", () => {
    const q = makeReceiptQuery({ link: "journal_voided" });
    expect(matchesReceiptQuery(receipt, "journal_voided", q)).toBe(true);
    expect(matchesReceiptQuery(receipt, "linked", q)).toBe(false);
    expect(matchesReceiptQuery(receipt, "none", q)).toBe(false);
  });

  it("削除済みは includeDeleted: true のときだけ", () => {
    const deleted = makeReceiptRow({
      deletedAt: "2026-10-25T00:00:00.000Z",
      deletedReason: "重複",
    });
    expect(matchesReceiptQuery(deleted, "none", makeReceiptQuery())).toBe(false);
    expect(matchesReceiptQuery(deleted, "none", makeReceiptQuery({ includeDeleted: true }))).toBe(
      true,
    );
    expect(matchesReceiptQuery(receipt, "none", makeReceiptQuery({ includeDeleted: true }))).toBe(
      true,
    );
  });

  it("すべて AND で組み合わせる", () => {
    const q = makeReceiptQuery({
      dateFrom: "2026-10-01",
      amountMax: 2000,
      partner: "cafe",
      category: "paper_scan",
      link: "none",
    });
    expect(matchesReceiptQuery(receipt, "none", q)).toBe(true);
    expect(matchesReceiptQuery(receipt, "linked", q)).toBe(false);
    expect(matchesReceiptQuery({ ...receipt, amount: 2001 }, "none", q)).toBe(false);
  });

  it("cursor・limit は条件にしない（ページの切り方は表の実装）", () => {
    expect(matchesReceiptQuery(receipt, "none", makeReceiptQuery({ cursor: "x", limit: 1 }))).toBe(
      true,
    );
  });
});
