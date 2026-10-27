import type { StatementColumnIndexes, StatementColumnMapping } from "@trebuchet/schema";
import fc from "fast-check";
import { COLUMN_ROLE_NAMES } from "../src/statements/columns.ts";
import type { StatementRow } from "../src/statements/table.ts";

/**
 * 明細の取込（006）の fast-check のジェネレーターと、明細の行から表のテキストを作る補助。
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

export const pastedRowArb: fc.Arbitrary<StatementRow> = fc.record({
  accountName: fc.constantFrom(...ACCOUNT_NAMES),
  date: dateIn2026Arb,
  content: fc.constantFrom(...CONTENTS),
  amount: signedAmountArb,
  transferFlag: fc.boolean(),
});

/**
 * 重複する行（同じ口座・日付・金額・内容）が混ざりやすい行の集まり。日付と内容を狭めて衝突させる
 */
export const pastedRowsArb: fc.Arbitrary<StatementRow[]> = fc.array(
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

/** `statementTableOf` の列の並び（役割 → 列の番号） */
const TABLE_ROLES = [
  "date",
  "content",
  "amount",
  "accountName",
  "categoryMajor",
  "categoryMinor",
  "memo",
  "transferFlag",
  "externalId",
] as const;

/** `statementTableOf` が使う年（日付は年つきなので結果に影響しない） */
export const TABLE_YEAR = 2026;

/**
 * 明細の行から、取込の入力のうち表に関わる部分（`text`・`mapping`・`year`）を作る。
 * タブ区切り・見出しつき・金額 1 列（入金が正）・日付は `YYYY-MM-DD`。
 * `readStatementTable(text, mapping, { year })` が同じ行を返す。どの形の表でも読めること（INV-49）は
 * `statement-table-arbitraries.ts` の生成器が確かめる。ここはユースケースのテストが行を渡すための簡単な入口
 */
export function statementTableOf(rows: readonly StatementRow[]): {
  text: string;
  mapping: StatementColumnMapping;
  year: number;
} {
  const lines = [TABLE_ROLES.map((role) => COLUMN_ROLE_NAMES[role][0]).join("\t")];
  for (const r of rows) {
    lines.push(
      [
        r.date,
        r.content,
        String(r.amount),
        r.accountName,
        r.categoryMajor ?? "",
        r.categoryMinor ?? "",
        r.memo ?? "",
        r.transferFlag ? "1" : "0",
        r.externalId ?? "",
      ].join("\t"),
    );
  }
  const columns: StatementColumnIndexes = Object.fromEntries(
    TABLE_ROLES.map((role, i) => [role, i]),
  );
  return {
    text: `${lines.join("\n")}\n`,
    mapping: { delimiter: "\t", headerRow: 0, columns, amountSign: "inflow_positive" },
    year: TABLE_YEAR,
  };
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
