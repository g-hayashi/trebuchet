import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  escapeLike,
  matchesReceiptQuery,
  normalizeReceiptText,
} from "../../src/receipts/search.ts";
import { makeReceiptQuery, makeReceiptRow } from "../receipt-setup.ts";

// INV-65（検索）: 全角・半角・大文字小文字・空白の違いだけの取引先は同じ結果になる。
// `%`・`_`・`\` はそのままの文字として比べる（LIKE ... ESCAPE '\' の意味を素朴に作って照らす）

/** 取引先に出る文字の集まり（ASCII の記号・英数字・かな・漢字・半角カナ。LIKE の記号を含む） */
const CHARS = [
  ..."abcXYZ019 -&.,%_\\",
  ..."株式会社カフェコーヒー店あいうえお",
  // 半角カナ（濁点の ﾞ は除く: かなと濁点の間に空白を入れると NFKC の合成が起きず結果が変わるため）
  ..."ｶﾌｪﾄｰ",
];
const textArb = fc.array(fc.constantFrom(...CHARS), { maxLength: 30 }).map((a) => a.join(""));
const nameArb = textArb.filter((s) => s.trim().length > 0);

/** 全角の英数字・記号にする（ASCII の 0x21〜0x7E → +0xFEE0。空白は全角の空白） */
const toFullWidth = (s: string): string =>
  [...s]
    .map((c) => {
      const code = c.charCodeAt(0);
      if (c === " ") return "　";
      return code >= 0x21 && code <= 0x7e ? String.fromCharCode(code + 0xfee0) : c;
    })
    .join("");

type Variant = { full: boolean; lower: boolean; spaces: number[] };
const variantArb: fc.Arbitrary<Variant> = fc.record({
  full: fc.boolean(),
  lower: fc.boolean(),
  spaces: fc.array(fc.nat({ max: 30 }), { maxLength: 4 }),
});

/** 見た目だけを変える（半角 → 全角、大文字 → 小文字、途中に空白を入れる） */
function vary(s: string, v: Variant): string {
  let out = v.lower ? s.toLowerCase() : s;
  if (v.full) out = toFullWidth(out);
  const chars = [...out];
  for (const at of [...v.spaces].sort((a, b) => b - a)) {
    chars.splice(Math.min(at, chars.length), 0, v.spaces.length % 2 === 0 ? " " : "　");
  }
  return chars.join("");
}

/** `LIKE pattern ESCAPE '\'` の素朴な評価（`%` は任意の長さ、`_` は 1 文字、`\x` は x そのもの） */
function likeMatches(pattern: string, value: string): boolean {
  let source = "";
  const chars = [...pattern];
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i] as string;
    if (c === "\\") {
      i += 1;
      source += (chars[i] ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (c === "%") source += ".*";
    else if (c === "_") source += ".";
    else source += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "s").test(value);
}

describe("INV-65: 検索の正規化と LIKE の逃がし", () => {
  it("normalizeReceiptText は見た目の違いを吸収し、何度かけても変わらない", () => {
    fc.assert(
      fc.property(nameArb, variantArb, (name, v) => {
        const key = normalizeReceiptText(name);
        expect(normalizeReceiptText(vary(name, v))).toBe(key);
        expect(normalizeReceiptText(key)).toBe(key);
        expect(/\s/.test(key)).toBe(false);
      }),
    );
  });

  it("見た目だけ違う取引先・検索語は、元と同じ結果になる", () => {
    fc.assert(
      fc.property(
        nameArb,
        fc.nat({ max: 29 }),
        fc.nat({ max: 29 }),
        variantArb,
        variantArb,
        (name, a, b, vName, vQuery) => {
          const chars = [...name];
          const from = Math.min(a, b) % chars.length;
          const to = Math.max(a, b) % (chars.length + 1);
          const part = chars.slice(from, Math.max(from, to)).join("");
          if (part.trim().length === 0) return;
          const plain = matchesReceiptQuery(
            makeReceiptRow({ partnerName: name }),
            "none",
            makeReceiptQuery({ partner: part }),
          );
          const varied = matchesReceiptQuery(
            makeReceiptRow({ partnerName: vary(name, vName).slice(0, 100) }),
            "none",
            makeReceiptQuery({ partner: vary(part, vQuery) }),
          );
          // 部分は元の名前の一部なので、元は合う。見た目を変えても（100 文字に収まる限り）合う
          expect(plain).toBe(true);
          if (vary(name, vName).length <= 100) expect(varied).toBe(plain);
        },
      ),
    );
  });

  it("取引先の検索は、正規化した文字列の部分一致と同じ（%・_・\\ もそのままの文字）", () => {
    fc.assert(
      fc.property(nameArb, nameArb, (name, term) => {
        const row = makeReceiptRow({ partnerName: name });
        const expected = normalizeReceiptText(name).includes(normalizeReceiptText(term));
        expect(matchesReceiptQuery(row, "none", makeReceiptQuery({ partner: term }))).toBe(
          expected,
        );
      }),
    );
  });

  it("escapeLike を通した語の LIKE '%…%' ESCAPE '\\' は、部分文字列の判定と同じ", () => {
    fc.assert(
      fc.property(textArb, textArb, (value, term) => {
        expect(likeMatches(`%${escapeLike(term)}%`, value)).toBe(value.includes(term));
      }),
    );
  });

  it("escapeLike は、逃がした文字を除くと元の語に戻る", () => {
    fc.assert(
      fc.property(textArb, (term) => {
        expect(escapeLike(term).replace(/\\([%_\\])/g, "$1")).toBe(term);
      }),
    );
  });

  it("未入力の取引先は、どの検索語にも合わない", () => {
    fc.assert(
      fc.property(nameArb, (term) => {
        const row = makeReceiptRow({ partnerName: null });
        expect(matchesReceiptQuery(row, "none", makeReceiptQuery({ partner: term }))).toBe(false);
      }),
    );
  });
});

describe("INV-65: 条件の AND", () => {
  it("1 つの条件ごとの結果の積と、まとめた条件の結果が一致する", () => {
    const rowArb = fc.record({
      date: fc.option(fc.constantFrom("2026-09-30", "2026-10-01", "2026-10-15", "2026-10-31"), {
        nil: null,
      }),
      amount: fc.option(fc.constantFrom(1, 500, 1000, 5000), { nil: null }),
      name: fc.option(fc.constantFrom("カフェ", "ＣＡＦＥ", "文具店", "a_b"), { nil: null }),
      category: fc.constantFrom("paper_scan", "electronic"),
      deleted: fc.boolean(),
      link: fc.constantFrom("none", "linked", "journal_voided"),
    });
    const queryArb = fc.record(
      {
        dateFrom: fc.constantFrom("2026-10-01", "2026-10-15"),
        dateTo: fc.constantFrom("2026-10-15", "2026-10-31"),
        amountMin: fc.constantFrom(0, 500, 1000),
        amountMax: fc.constantFrom(500, 1000, 5000),
        partner: fc.constantFrom("cafe", "店", "_"),
        category: fc.constantFrom("paper_scan", "electronic"),
        missing: fc.boolean(),
        link: fc.constantFrom("none", "linked", "journal_voided"),
        includeDeleted: fc.boolean(),
      },
      { requiredKeys: [] },
    );
    fc.assert(
      fc.property(rowArb, queryArb, (r, input) => {
        const row = makeReceiptRow({
          transactionDate: r.date,
          amount: r.amount,
          partnerName: r.name,
          category: r.category,
          deletedAt: r.deleted ? "2026-10-25T00:00:00.000Z" : null,
          deletedReason: r.deleted ? "削除" : null,
        });
        const whole = matchesReceiptQuery(row, r.link, makeReceiptQuery(input));
        // includeDeleted 以外の条件を 1 つずつ（削除済みを含めて）確かめ、削除済みの規則は別に掛ける
        const single = Object.entries(input)
          .filter(([key]) => key !== "includeDeleted")
          .every(([key, value]) =>
            matchesReceiptQuery(
              row,
              r.link,
              makeReceiptQuery({ includeDeleted: true, [key]: value }),
            ),
          );
        expect(whole).toBe(single && (input.includeDeleted === true || !r.deleted));
      }),
    );
  });
});
