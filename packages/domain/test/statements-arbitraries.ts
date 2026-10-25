import fc from "fast-check";
import type { PastedRow } from "../src/statements/paste.ts";

/**
 * 明細の取込（006）の fast-check のジェネレーターと、貼り付けのテキストを作る補助。
 * 名前はすべて合成（実在の店名・口座名・個人名を書かない）。INV-40・44 の性質テストが使う
 */

export const ACCOUNT_NAMES = ["サンプル銀行", "テストカードA", "テスト現金"] as const;

const CONTENTS = [
  "ショップ001",
  "ショップ002 ご利用",
  "ｻﾝﾌﾟﾙ商店",
  "サンプル商店",
  "テスト電力 1234567",
  "テスト通信 料金",
  "振込 ﾃｽﾄﾀﾛｳ",
  "カード引落 テストカードA",
  "給与",
] as const;

/** 2026 年の実在する日付（YYYY-MM-DD） */
export const dateIn2026Arb: fc.Arbitrary<string> = fc
  .integer({ min: 0, max: 364 })
  .map((offset) => new Date(Date.UTC(2026, 0, 1 + offset)).toISOString().slice(0, 10));

/** 0 でない金額（入金が正、出金が負） */
export const signedAmountArb: fc.Arbitrary<number> = fc
  .integer({ min: 1, max: 5_000_000 })
  .chain((n) => fc.boolean().map((negative) => (negative ? -n : n)));

export const pastedRowArb: fc.Arbitrary<PastedRow> = fc.record({
  accountName: fc.constantFrom(...ACCOUNT_NAMES),
  date: dateIn2026Arb,
  content: fc.constantFrom(...CONTENTS),
  amount: signedAmountArb,
  transferFlag: fc.boolean(),
});

/**
 * 重複する行（同じ口座・日付・金額・内容）が混ざりやすい行の集まり。日付と内容を狭めて衝突させる
 */
export const pastedRowsArb: fc.Arbitrary<PastedRow[]> = fc.array(
  fc.record({
    accountName: fc.constantFrom(...ACCOUNT_NAMES.slice(0, 2)),
    date: fc.constantFrom("2026-05-01", "2026-05-02", "2026-05-20"),
    content: fc.constantFrom(...CONTENTS.slice(0, 4)),
    amount: fc.constantFrom(-500, -1_200, 3_000),
    transferFlag: fc.boolean(),
  }),
  { minLength: 1, maxLength: 12 },
);

/** 取込元の口座（`planStatementImport` の accounts に渡す形） */
export const accountsFor = (names: readonly string[] = ACCOUNT_NAMES) =>
  names.map((name) => ({ name }));

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

const yen = (n: number): string => {
  const abs = Math.abs(n).toLocaleString("en-US");
  return n < 0 ? `-${abs}` : abs;
};

/** `MM/DD(曜)`（MF ME の表の日付） */
export function mfmeDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}(${weekday})`;
}

export const MFME_HEADER = [
  "計算対象",
  "日付",
  "内容",
  "金額（円）",
  "保有金融機関",
  "大項目",
  "中項目",
  "メモ",
  "振替",
].join("\t");

/**
 * 行から MF ME の貼り付けのテキストを作る（タブ区切り、見出しつき）。
 * `parseMfmePaste(formatMfmePaste(rows), year)` が同じ行を返す（日付の年は rows の年）
 */
export function formatMfmePaste(rows: readonly PastedRow[], options: { header?: boolean } = {}) {
  const withHeader = options.header !== false;
  const lines = withHeader ? [MFME_HEADER] : [];
  for (const r of rows) {
    lines.push(
      [
        // 見出しなしの既定の並びは日付から始まる（計算対象の列を持たない）
        ...(withHeader ? ["1"] : []),
        mfmeDate(r.date),
        r.content,
        yen(r.amount),
        r.accountName,
        r.categoryMajor ?? "",
        r.categoryMinor ?? "",
        r.memo ?? "",
        r.transferFlag ? "1" : "0",
      ].join("\t"),
    );
  }
  return `${lines.join("\n")}\n`;
}

/** 口座の用途（INV-42 の性質テスト） */
export const usageArb: fc.Arbitrary<"business" | "mixed" | "private"> = fc.constantFrom(
  "business",
  "mixed",
  "private",
);

/** 判定（事業・私用） */
export const purposeArb: fc.Arbitrary<"business" | "private"> = fc.constantFrom(
  "business",
  "private",
);

/** 仕訳の金額（1 円以上、1e12 未満の整数）。符号は呼び出し側で付ける */
export const absAmountArb: fc.Arbitrary<number> = fc.integer({ min: 1, max: 999_999_999_999 });

/** 配列の並びを入れ替える（fast-check の `shuffle` 相当を、性質テストの入力として使う） */
export const permutationOf = <T>(items: readonly T[]): fc.Arbitrary<T[]> =>
  fc.shuffledSubarray([...items], { minLength: items.length, maxLength: items.length });
