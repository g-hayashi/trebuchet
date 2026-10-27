import type { StatementAmountSign, StatementColumnMapping } from "@trebuchet/schema";
import fc from "fast-check";
import { COLUMN_ROLE_NAMES } from "../src/statements/columns.ts";

/**
 * 明細の表（007）の fast-check のジェネレーター。明細の行（日付・内容・符号つきの金額・口座）から、
 * 区切り文字・引用・前置き・見出しの有無・列の並び・金額 1 列（符号の向き 2 通り）か 2 列・金額と日付の書き方を変えた
 * テキストと、正しい対応を作る（R14）。INV-49・INV-50（後半）の性質テストが使う。名前はすべて合成
 */

export type ExpectedRow = { accountName: string; date: string; content: string; amount: number };

/** 生成した表。`rows` は読めるはずの行（口座は固定の口座なら `fixedAccountName` に置き換え済み） */
export type TableScenario = {
  text: string;
  mapping: StatementColumnMapping;
  year: number;
  fixedAccountName?: string;
  rows: ExpectedRow[];
  /** 読めない行として混ぜた行の数 */
  junkCount: number;
};

export const SCENARIO_YEAR = 2026;

const DELIMITERS = ["\t", ",", ";"] as const;

const ACCOUNT_NAMES = [
  "サンプル銀行",
  "テストカードA",
  "テスト現金",
  "A,銀行",
  'B"カード',
] as const;

const TOKENS = [
  "ショップ001",
  "ご利用",
  "ｻﾝﾌﾟﾙ",
  "ﾃｽﾄ",
  "テスト電力",
  "1234567",
  "a,b",
  '"特選"',
  "x;y",
  "p\tq",
  "line1\nline2",
  "ＡＢＣ",
  "返品",
] as const;

/** 前後に空白がなく、空でない内容（区切り・引用・改行を含みうる） */
export const contentArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...TOKENS), { minLength: 1, maxLength: 3 })
  .map((tokens) => tokens.join(" "));

const accountArb = fc.constantFrom(...ACCOUNT_NAMES);

/** 1990-01-01〜2035-12-31 の実在する日付（平成・令和にまたがる） */
export const dateArb: fc.Arbitrary<string> = fc
  .integer({ min: 0, max: 16_800 })
  .map((offset) => new Date(Date.UTC(1990, 0, 1 + offset)).toISOString().slice(0, 10));

/** 0 でない金額（入金が正、出金が負） */
export const amountArb: fc.Arbitrary<number> = fc
  .integer({ min: 1, max: 5_000_000 })
  .chain((n) => fc.boolean().map((negative) => (negative ? -n : n)));

const p2 = (n: number): string => String(n).padStart(2, "0");
const comma = (n: number): string => n.toLocaleString("en-US");
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

/** 日付の書き方の数（`formatDate` の style は 0〜DATE_STYLES-1） */
export const DATE_STYLES = 12;

/** YYYY-MM-DD を style の書き方にする。年のない書き方は、年が `SCENARIO_YEAR` のときだけ（ほかは `YYYY/MM/DD`） */
export function formatDate(date: string, style: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const reiwa = date >= "2019-05-01";
  const eraYear = reiwa ? y - 2018 : y - 1988;
  switch (style) {
    case 1:
      return `${y}-${p2(m)}-${p2(d)}`;
    case 2:
      return `${y}.${p2(m)}.${p2(d)}`;
    case 3:
      return `${y}年${m}月${d}日`;
    case 4:
      return `${y}${p2(m)}${p2(d)}`;
    case 5:
    case 11: {
      if (y !== SCENARIO_YEAR) return `${y}/${p2(m)}/${p2(d)}`;
      if (style === 11) return `${p2(m)}/${p2(d)}`;
      const w = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
      return `${p2(m)}/${p2(d)}(${w})`;
    }
    case 6:
      return `${reiwa ? "令和" : "平成"}${eraYear === 1 ? "元" : eraYear}年${m}月${d}日`;
    case 7:
      return `${reiwa ? "R" : "H"}${eraYear}.${m}.${p2(d)}`;
    case 8:
      return `${reiwa ? "R" : "H"}${eraYear}/${m}/${d}`;
    case 9:
      return `${y}/${p2(m)}/${p2(d)} ${p2(d % 24)}:${p2(m)}`;
    case 10:
      return `${y}/${p2(m)}/${p2(d)}`.replace(/\d/g, (c) =>
        String.fromCharCode(c.charCodeAt(0) + 0xfee0),
      );
    default:
      return `${y}/${p2(m)}/${p2(d)}`;
  }
}

/** 金額の書き方の数（`formatAmount` の style は 0〜AMOUNT_STYLES-1） */
export const AMOUNT_STYLES = 8;

/** 符号つきの整数 v を style の書き方にする（正も負も読める書き方だけ） */
export function formatAmount(v: number, style: number): string {
  const neg = v < 0;
  const abs = Math.abs(v);
  switch (style) {
    case 1:
      return neg ? `-${comma(abs)}` : comma(abs);
    case 2:
      return neg ? `-¥${comma(abs)}` : `¥${comma(abs)}`;
    case 3:
      return neg ? `-${comma(abs)}円` : `${comma(abs)}円`;
    case 4:
      return `${neg ? "−" : ""}${comma(abs)}`.replace(/\d|,/g, (c) =>
        c === "," ? "，" : String.fromCharCode(c.charCodeAt(0) + 0xfee0),
      );
    case 5:
      return neg ? `△${comma(abs)}` : comma(abs);
    case 6:
      return neg ? `(${comma(abs)})` : comma(abs);
    case 7:
      return neg ? `▲${comma(abs)}` : `+${comma(abs)}`;
    default:
      return String(v);
  }
}

type CellKind =
  | "date"
  | "content"
  | "amount"
  | "outflow"
  | "inflow"
  | "accountName"
  | "noise0"
  | "noise1";

const quoteCell = (cell: string, delimiter: string, all: boolean): string => {
  const needed = cell.includes(delimiter) || /["\r\n]/.test(cell);
  return all || needed ? `"${cell.replaceAll('"', '""')}"` : cell;
};

type RowSpec = {
  row: ExpectedRow;
  dateStyle: number;
  amountStyle: number;
  /** 2 列のとき、値のない側を空にするか 0 にするか */
  zeroFill: boolean;
};

type Junk = { kind: "date" | "short" | "blank"; position: number };

type ScenarioSpec = {
  delimiter: (typeof DELIMITERS)[number];
  quoteAll: boolean;
  eol: "\n" | "\r\n";
  trailingEol: boolean;
  preamble: string[];
  hasHeader: boolean;
  mode: "inflow_positive" | "outflow_positive" | "split" | "split_negated";
  fixedAccountName: string | undefined;
  noiseCount: number;
  order: number[];
  specs: RowSpec[];
  junk: Junk[];
};

const PREAMBLE_LINES = [
  "ご利用明細",
  "対象期間 2026/10/01-2026/10/31",
  "口座番号,999-0000001",
  "",
  "合計 3 件",
] as const;

/** 生成した仕様から、テキストと正しい対応を作る */
function buildScenario(spec: ScenarioSpec): TableScenario {
  const { delimiter } = spec;
  const split = spec.mode === "split" || spec.mode === "split_negated";
  const kinds: CellKind[] = ["date", "content"];
  if (split) kinds.push("outflow", "inflow");
  else kinds.push("amount");
  if (spec.fixedAccountName === undefined) kinds.push("accountName");
  if (spec.noiseCount >= 1) kinds.push("noise0");
  if (spec.noiseCount >= 2) kinds.push("noise1");
  // order は 0..n-1 の並べ替えの元（長さが足りなければ末尾に補う）
  const order = [...new Set(spec.order.filter((i) => i < kinds.length))];
  for (let i = 0; i < kinds.length; i++) if (!order.includes(i)) order.push(i);
  const columns = order.map((i) => kinds[i] as CellKind);

  const quote = (c: string) => quoteCell(c, delimiter, spec.quoteAll);
  const line = (cells: string[]) => cells.map(quote).join(delimiter);

  const roleName = (k: CellKind): string => {
    if (k === "noise0") return "残高";
    if (k === "noise1") return "備考欄";
    return COLUMN_ROLE_NAMES[k][0] as string;
  };

  const amountSign: StatementAmountSign =
    spec.mode === "outflow_positive" ? "outflow_positive" : "inflow_positive";
  const dataLine = (s: RowSpec, dateText?: string): string =>
    line(
      columns.map((k): string => {
        switch (k) {
          case "date":
            return dateText ?? formatDate(s.row.date, s.dateStyle);
          case "content":
            return s.row.content;
          case "accountName":
            return s.row.accountName;
          case "noise0":
            return comma(Math.abs(s.row.amount) * 3);
          case "amount":
            return formatAmount(
              spec.mode === "outflow_positive" ? -s.row.amount : s.row.amount,
              s.amountStyle,
            );
          case "outflow":
          case "inflow": {
            // 通常: 入金は入金の列に正の値、出金は出金の列に正の値。
            // negated: 入金は出金の列に負の値、出金は入金の列に負の値（出金の列の負の値は入金。R5）
            const negated = spec.mode === "split_negated";
            const isInflow = s.row.amount > 0;
            const target = isInflow !== negated ? "inflow" : "outflow";
            if (k !== target) return s.zeroFill ? "0" : "";
            const abs = Math.abs(s.row.amount);
            return formatAmount(negated ? -abs : abs, s.amountStyle);
          }
          default:
            return ""; // noise1（空の列）
        }
      }),
    );

  const lines: string[] = [];
  for (const s of spec.specs) lines.push(dataLine(s));
  const first = spec.specs[0] as RowSpec;
  for (const j of spec.junk) {
    const at = j.position % (lines.length + 1);
    const text = j.kind === "blank" ? "" : j.kind === "short" ? "小計" : dataLine(first, "合計");
    lines.splice(at, 0, text);
  }

  const all: string[] = [...spec.preamble];
  if (spec.hasHeader) all.push(line(columns.map(roleName)));
  all.push(...lines);
  const text = all.join(spec.eol) + (spec.trailingEol ? spec.eol : "");

  const indexOf = (k: CellKind): number => columns.indexOf(k);
  const mapped: StatementColumnMapping["columns"] = {
    date: indexOf("date"),
    content: indexOf("content"),
  };
  if (split) {
    mapped.outflow = indexOf("outflow");
    mapped.inflow = indexOf("inflow");
  } else {
    mapped.amount = indexOf("amount");
  }
  if (spec.fixedAccountName === undefined) mapped.accountName = indexOf("accountName");

  const mapping: StatementColumnMapping = {
    delimiter,
    headerRow: spec.hasHeader ? spec.preamble.length : null,
    columns: mapped,
    ...(split ? {} : { amountSign }),
  };
  const fixed = spec.fixedAccountName;
  return {
    text,
    mapping,
    year: SCENARIO_YEAR,
    ...(fixed === undefined ? {} : { fixedAccountName: fixed }),
    rows: spec.specs.map((s) => ({
      ...s.row,
      accountName: fixed ?? s.row.accountName,
    })),
    junkCount: spec.junk.filter((j) => j.kind !== "blank").length,
  };
}

const rowSpecArb: fc.Arbitrary<RowSpec> = fc.record({
  row: fc.record({
    accountName: accountArb,
    date: dateArb,
    content: contentArb,
    amount: amountArb,
  }),
  dateStyle: fc.integer({ min: 0, max: DATE_STYLES - 1 }),
  amountStyle: fc.integer({ min: 0, max: AMOUNT_STYLES - 1 }),
  zeroFill: fc.boolean(),
});

const scenarioSpecArb = (opts: { fixedAccount: boolean | undefined }): fc.Arbitrary<ScenarioSpec> =>
  fc
    .record({
      delimiter: fc.constantFrom(...DELIMITERS),
      quoteAll: fc.boolean(),
      eol: fc.constantFrom("\n" as const, "\r\n" as const),
      trailingEol: fc.boolean(),
      hasHeader: fc.boolean(),
      preamble: fc.array(fc.constantFrom(...PREAMBLE_LINES), { maxLength: 3 }),
      mode: fc.constantFrom(
        "inflow_positive" as const,
        "outflow_positive" as const,
        "split" as const,
        "split_negated" as const,
      ),
      fixedAccountName:
        opts.fixedAccount === undefined
          ? fc.option(accountArb, { nil: undefined })
          : opts.fixedAccount
            ? accountArb
            : fc.constant(undefined),
      noiseCount: fc.integer({ min: 0, max: 2 }),
      order: fc.shuffledSubarray([0, 1, 2, 3, 4, 5, 6], { minLength: 7, maxLength: 7 }),
      specs: fc.array(rowSpecArb, { minLength: 1, maxLength: 12 }),
      junk: fc.array(
        fc.record({
          kind: fc.constantFrom("date" as const, "short" as const, "blank" as const),
          position: fc.nat({ max: 30 }),
        }),
        { maxLength: 4 },
      ),
    })
    .map((spec) => ({
      ...spec,
      // 見出しがなければ前置きの行は付けない（headerRow が null なら全行がデータ）
      preamble: spec.hasHeader ? spec.preamble : [],
    }));

/** 任意の形の表。口座は列にあるか固定（INV-49） */
export const tableScenarioArb: fc.Arbitrary<TableScenario> = scenarioSpecArb({
  fixedAccount: undefined,
}).map(buildScenario);

/** 1 つの口座の取込元（`accountName` の役割がない）の表（INV-50 の後半） */
export const fixedAccountTableArb: fc.Arbitrary<TableScenario> = scenarioSpecArb({
  fixedAccount: true,
}).map(buildScenario);
