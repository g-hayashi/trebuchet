/**
 * 明細のフィクスチャ（このディレクトリのファイル）の期待値。値は README.md の「検算」で確かめた。金額はすべて合成の値。
 *
 * - rowCount: 読める明細の行の数（見出し・前置きを除く）
 * - inflowTotal / outflowTotal: 入金の合計・出金の合計（どちらも正の値。符号つきの金額で入金が正）。
 *   「返金」「出金の列の負の値」「出金額が正のカードの負の値」は入金に数える
 * - mapping: 正しい列の対応（research R4・data-model §3 の `StatementColumnMapping`。headerRow は元のテキストの行の番号（0 起点）、
 *   columns は列の番号（0 起点）。schema の型ができるまでは自前の型）
 * - preambleLines: 見出しより前の説明の行の数（前置き）
 * - year: 日付が `MM/DD` のときに使う年（貼り付けの年）
 */

export type FixtureRole =
  | "date"
  | "content"
  | "amount"
  | "outflow"
  | "inflow"
  | "accountName"
  | "categoryMajor"
  | "categoryMinor"
  | "memo"
  | "externalId"
  | "transferFlag";

export type FixtureMapping = {
  delimiter: "\t" | "," | ";";
  headerRow: number | null;
  columns: Partial<Record<FixtureRole, number>>;
  amountSign?: "inflow_positive" | "outflow_positive";
};

export type ExpectedStatementFixture = {
  file: string;
  /** CP932 のファイルのとき true（それ以外は UTF-8、BOM なし） */
  cp932?: boolean;
  rowCount: number;
  inflowTotal: number;
  outflowTotal: number;
  preambleLines: number;
  year?: number;
  mapping: FixtureMapping;
};

/** MF ME の表の貼り付け（タブ区切り。日付は `MM/DD(曜)` で年を持たない） */
export const MFME_PASTE: ExpectedStatementFixture = {
  file: "mfme-paste.txt",
  rowCount: 10,
  inflowTotal: 386_500,
  outflowTotal: 61_500,
  preambleLines: 0,
  year: 2026,
  mapping: {
    delimiter: "\t",
    headerRow: 0,
    columns: {
      date: 1,
      content: 2,
      amount: 3,
      accountName: 4,
      categoryMajor: 5,
      categoryMinor: 6,
      memo: 7,
      transferFlag: 8,
      externalId: 9,
    },
    amountSign: "inflow_positive",
  },
};

/** 出金・入金の 2 列、前置き 3 行の銀行の CSV（CP932。UTF-8 の元は `bank-two-columns.utf8.csv`）。残高の列（4）は読まない */
export const BANK_TWO_COLUMNS: ExpectedStatementFixture = {
  file: "bank-two-columns.csv",
  cp932: true,
  rowCount: 10,
  inflowTotal: 452_512,
  outflowTotal: 158_930,
  preambleLines: 3,
  mapping: {
    delimiter: ",",
    headerRow: 3,
    columns: { date: 0, content: 1, outflow: 2, inflow: 3 },
  },
};

/** 正が出金のカードの CSV。引用の中のカンマ、返金の負の値、`¥`・`円` つきの金額、引用の中の `""` を含む */
export const CARD_OUTFLOW_POSITIVE: ExpectedStatementFixture = {
  file: "card-outflow-positive.csv",
  rowCount: 10,
  inflowTotal: 5_300,
  outflowTotal: 35_980,
  preambleLines: 0,
  mapping: {
    delimiter: ",",
    headerRow: 0,
    columns: { date: 0, content: 1, amount: 2, memo: 4 },
    amountSign: "outflow_positive",
  },
};

/** 和暦・全角・`△`/`▲`/括弧の負の CSV。日付は行ごとに読む（`dates` は行の順の ISO の日付） */
export const BANK_WAREKI: ExpectedStatementFixture & { dates: string[] } = {
  file: "bank-wareki.csv",
  rowCount: 10,
  inflowTotal: 336_012,
  outflowTotal: 151_700,
  preambleLines: 0,
  mapping: {
    delimiter: ",",
    headerRow: 0,
    columns: { date: 0, content: 1, amount: 2 },
    amountSign: "inflow_positive",
  },
  dates: [
    "2026-10-01",
    "2026-10-03",
    "2026-10-05",
    "2026-10-10",
    "2026-10-14",
    "2026-10-20",
    "2019-05-01",
    "2019-04-30",
    "2018-12-28",
    "2025-12-31",
  ],
};

/** 見出しなしの CSV（日付・内容・金額・残高。残高の列（3）は読まない）。列の名前は「列 1」…になる */
export const NO_HEADER: ExpectedStatementFixture = {
  file: "no-header.csv",
  rowCount: 8,
  inflowTotal: 440_012,
  outflowTotal: 146_430,
  preambleLines: 0,
  mapping: {
    delimiter: ",",
    headerRow: null,
    columns: { date: 0, content: 1, amount: 2 },
    amountSign: "inflow_positive",
  },
};

/**
 * 辞書（R4）に当たらない独自の見出しの CSV（US4。AI の列の案の入力）。
 * 辞書だけでは案が出ない。正しい対応は、見出しの行が最初の行で、日付・内容・金額（符号つき）。整理番号の列（3）は読まない
 */
export const CUSTOM_HEADER: ExpectedStatementFixture = {
  file: "custom-header.csv",
  rowCount: 8,
  inflowTotal: 389_950,
  outflowTotal: 33_590,
  preambleLines: 0,
  mapping: {
    delimiter: ",",
    headerRow: 0,
    columns: { date: 0, content: 1, amount: 2 },
    amountSign: "inflow_positive",
  },
};

export const ALL_STATEMENT_FIXTURES = [
  MFME_PASTE,
  BANK_TWO_COLUMNS,
  CARD_OUTFLOW_POSITIVE,
  BANK_WAREKI,
  NO_HEADER,
  CUSTOM_HEADER,
] as const;
