import type { StatementColumnRole } from "@trebuchet/schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { COLUMN_ROLE_NAMES } from "../../src/statements/columns.ts";
import { detectTableLayout } from "../../src/statements/table.ts";
import { dateArb, formatDate } from "../statement-table-arbitraries.ts";

// 007/R2 の性質: 区切り文字（タブ・カンマ・セミコロン）、見出しの行（辞書の見出し・辞書にない見出し・見出しなし）、
// 前置き 0〜3 行（1〜2 セル）で作った表について、区切り文字と見出しの行が正しく判定される。
// 前置き・見出しのセルには日付・金額に見える値を入れない。内容のセルには区切り文字・引用符を入れない

const DELIMITERS = ["\t", ",", ";"] as const;
type Delimiter = (typeof DELIMITERS)[number];

const PREAMBLE_CELLS = ["サンプル銀行 入出金明細", "対象期間", "ご案内", "作成元 テスト", "備え"];
const CONTENTS = ["ショップ001", "ご利用", "ｻﾝﾌﾟﾙ", "テスト電力", "返品", "ＡＢＣ"];
const ACCOUNTS = ["サンプル銀行", "テストカードA"];
/** 見出しの名前が辞書に当たらない列（独自の見出し） */
const CUSTOM_NAMES = ["項目一", "項目二", "項目三", "項目四", "項目五", "項目六"];

type Kind = "date" | "content" | "amount" | "outflow" | "inflow" | "accountName" | "noise";
const WEEKDAY_YEARLESS = /^\d{2}\/\d{2}(\([日月火水木金土]\))?$/;

type Spec = {
  delimiter: Delimiter;
  eol: "\n" | "\r\n";
  trailingEol: boolean;
  quoteAll: boolean;
  headerKind: "dict" | "custom" | "none";
  preamble: string[][];
  split: boolean;
  withAccount: boolean;
  withNoise: boolean;
  order: number[];
  nameIndex: number[];
  rows: { date: string; dateStyle: number; content: string; account: string; amount: number }[];
  blanks: number[];
};

const specArb: fc.Arbitrary<Spec> = fc.record({
  delimiter: fc.constantFrom(...DELIMITERS),
  eol: fc.constantFrom("\n" as const, "\r\n" as const),
  trailingEol: fc.boolean(),
  quoteAll: fc.boolean(),
  headerKind: fc.constantFrom("dict" as const, "custom" as const, "none" as const),
  preamble: fc.array(fc.array(fc.constantFrom(...PREAMBLE_CELLS), { minLength: 1, maxLength: 2 }), {
    maxLength: 3,
  }),
  split: fc.boolean(),
  withAccount: fc.boolean(),
  withNoise: fc.boolean(),
  order: fc.shuffledSubarray([0, 1, 2, 3, 4, 5], { minLength: 6, maxLength: 6 }),
  nameIndex: fc.array(fc.nat({ max: 20 }), { minLength: 6, maxLength: 6 }),
  // 前置き 3 行より、見出し + データの行（列が 3 以上）が多くなるようにする
  rows: fc.array(
    fc.record({
      date: dateArb,
      dateStyle: fc.integer({ min: 0, max: 11 }),
      content: fc.constantFrom(...CONTENTS),
      account: fc.constantFrom(...ACCOUNTS),
      amount: fc.integer({ min: -5_000_000, max: 5_000_000 }),
    }),
    { minLength: 4, maxLength: 14 },
  ),
  blanks: fc.array(fc.nat({ max: 20 }), { maxLength: 3 }),
});

/** 区切り文字を含まない金額の書き方（カンマの桁区切りは使わない） */
const amountText = (v: number, style: number): string => {
  const n = Math.abs(v);
  switch (style % 4) {
    case 1:
      return v < 0 ? `-¥${n}` : `¥${n}`;
    case 2:
      return v < 0 ? `△${n}` : String(n);
    case 3:
      return v < 0 ? `(${n})` : `${n}円`;
    default:
      return String(v);
  }
};

type Built = {
  text: string;
  delimiter: Delimiter;
  headerRow: number | null;
  header: string[] | null;
  columnCount: number;
  rowCount: number;
  sampleRows: string[][];
  needsYear: boolean;
  suggested: Partial<Record<StatementColumnRole, number>>;
};

function build(spec: Spec): Built {
  const kinds: Kind[] = ["date", "content"];
  if (spec.split) kinds.push("outflow", "inflow");
  else kinds.push("amount");
  if (spec.withAccount) kinds.push("accountName");
  if (spec.withNoise) kinds.push("noise");
  const order = [...new Set(spec.order.filter((i) => i < kinds.length))];
  for (let i = 0; i < kinds.length; i++) if (!order.includes(i)) order.push(i);
  const columns = order.map((i) => kinds[i] as Kind);

  const quote = (cell: string) => (spec.quoteAll ? `"${cell}"` : cell);
  const line = (cells: string[]) => cells.map(quote).join(spec.delimiter);

  const headerCells = columns.map((k, position): string => {
    if (spec.headerKind === "custom") return CUSTOM_NAMES[position] as string;
    if (k === "noise") return "残高";
    const names = COLUMN_ROLE_NAMES[k];
    return names[(spec.nameIndex[position] as number) % names.length] as string;
  });

  let yearless = false;
  const dataRows = spec.rows.map((r) =>
    columns.map((k): string => {
      switch (k) {
        case "date": {
          const text = formatDate(r.date, r.dateStyle);
          if (WEEKDAY_YEARLESS.test(text)) yearless = true;
          return text;
        }
        case "content":
          return r.content;
        case "accountName":
          return r.account;
        case "noise":
          return String(Math.abs(r.amount));
        case "amount":
          return amountText(r.amount, r.dateStyle);
        case "outflow":
          return r.amount < 0 ? amountText(-r.amount, r.dateStyle) : "";
        default:
          return r.amount < 0 ? "" : amountText(r.amount, r.dateStyle);
      }
    }),
  );

  const hasHeader = spec.headerKind !== "none";
  // 見出しなしでも前置きはある（最頻値の列数を持つ最初の行より前。R2-3）
  const preamble = spec.preamble;
  const lines: string[] = preamble.map(line);
  if (hasHeader) lines.push(line(headerCells));
  const dataLines = dataRows.map(line);
  // 空行を、データの行の間に入れる
  for (const at of spec.blanks) dataLines.splice(at % (dataLines.length + 1), 0, "");
  lines.push(...dataLines);
  const text = lines.join(spec.eol) + (spec.trailingEol ? spec.eol : "");

  const suggested: Partial<Record<StatementColumnRole, number>> = {};
  if (spec.headerKind === "dict") {
    columns.forEach((k, position) => {
      if (k !== "noise") suggested[k] = position;
    });
  }
  return {
    text,
    delimiter: spec.delimiter,
    headerRow: hasHeader ? preamble.length : null,
    header: hasHeader ? headerCells : null,
    columnCount: columns.length,
    rowCount: dataRows.length,
    sampleRows: dataRows.slice(0, 10),
    needsYear: yearless,
    suggested,
  };
}

describe("detectTableLayout の性質（R2）", () => {
  it("生成した表の区切り文字・見出しの行・見出し・案・行数・見本・needsYear を当てる", () => {
    fc.assert(
      fc.property(specArb, (spec) => {
        const built = build(spec);
        const result = detectTableLayout(built.text);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const layout = result.value;
        expect(layout.delimiter).toBe(built.delimiter);
        expect(layout.headerRow).toBe(built.headerRow);
        expect(layout.header).toEqual(built.header);
        expect(layout.columnCount).toBe(built.columnCount);
        expect(layout.rowCount).toBe(built.rowCount);
        expect(layout.sampleRows).toEqual(built.sampleRows);
        expect(layout.suggestedColumns).toEqual(built.suggested);
        expect(layout.needsYear).toBe(built.needsYear);
      }),
      { numRuns: 300 },
    );
  });

  it("利用者が区切り文字・見出しの行を指定しても、同じ表なら同じ結果になる（選び直しは判定の 2・3 だけをやり直す）", () => {
    fc.assert(
      fc.property(specArb, (spec) => {
        const built = build(spec);
        const auto = detectTableLayout(built.text);
        const manual = detectTableLayout(built.text, {
          delimiter: built.delimiter,
          headerRow: built.headerRow,
        });
        expect(manual).toEqual(auto);
      }),
      { numRuns: 100 },
    );
  });
});
