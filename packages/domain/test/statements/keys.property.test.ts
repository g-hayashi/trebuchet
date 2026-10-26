import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { assignKeys, stableKey } from "../../src/statements/keys.ts";
import { normalizeContent } from "../../src/statements/normalize.ts";
import { pastedRowsArb, permutationOf } from "../statements-arbitraries.ts";

// 006 R3・R9。明細のキーと内容の正規化（INV-40 の基礎）

describe("normalizeContent", () => {
  it("NFKC → 大文字 → 空白を除く → 3 桁以上の数字を # にする", () => {
    expect(normalizeContent("ｻﾝﾌﾟﾙ ショップ")).toBe("サンプルショップ");
    expect(normalizeContent("abc　Def")).toBe("ABCDEF");
    expect(normalizeContent("ショップ001")).toBe("ショップ#");
    expect(normalizeContent("テスト電力 1234567")).toBe("テスト電力#");
    expect(normalizeContent("Ａ１２３")).toBe("A#"); // 全角の数字は NFKC で半角になってから置き換える
  });

  it("2 桁以下の数字は残し、数字の並びごとに # にする", () => {
    expect(normalizeContent("第12回")).toBe("第12回");
    expect(normalizeContent("A123B4567")).toBe("A#B#");
  });

  it("冪等", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const once = normalizeContent(s);
        expect(normalizeContent(once)).toBe(once);
      }),
    );
  });
});

describe("stableKey", () => {
  it("口座名|日付|金額|正規化した内容|n の文字列そのもの", () => {
    const row = {
      accountName: "サンプル銀行",
      date: "2026-05-01",
      amount: -1200,
      content: "ショップ001",
    };
    expect(stableKey(row, 0)).toBe("サンプル銀行|2026-05-01|-1200|ショップ#|0");
    expect(stableKey(row, 2)).toBe("サンプル銀行|2026-05-01|-1200|ショップ#|2");
  });
});

describe("assignKeys", () => {
  it("同じ口座・日付・金額・内容の行は、出現の順に 0, 1, ... を振る", () => {
    const base = { accountName: "A", date: "2026-05-01", amount: -500, content: "店" };
    const keys = assignKeys([base, { ...base, amount: -600 }, base, base]);
    expect(keys).toEqual([
      "A|2026-05-01|-500|店|0",
      "A|2026-05-01|-600|店|0",
      "A|2026-05-01|-500|店|1",
      "A|2026-05-01|-500|店|2",
    ]);
  });

  it("入力と同じ順・同じ長さで返す", () => {
    fc.assert(
      fc.property(pastedRowsArb, (rows) => {
        expect(assignKeys(rows)).toHaveLength(rows.length);
      }),
    );
  });

  it("キーは重複しない", () => {
    fc.assert(
      fc.property(pastedRowsArb, (rows) => {
        const keys = assignKeys(rows);
        expect(new Set(keys).size).toBe(keys.length);
      }),
    );
  });

  it("行の順を入れ替えてもキーの集合が同じ", () => {
    fc.assert(
      fc.property(
        pastedRowsArb.chain((rows) => fc.tuple(fc.constant(rows), permutationOf(rows))),
        ([rows, shuffled]) => {
          expect([...assignKeys(shuffled)].sort()).toEqual([...assignKeys(rows)].sort());
        },
      ),
    );
  });
});
