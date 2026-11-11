/**
 * freee の書き出しのうち取込で使う列の名前（research R3）。列は位置ではなく列名で特定する。
 * 表記は分析メモによる。実ファイルのヘッダとの照合は `pnpm verify:freee`
 */

const sideColumns = <P extends "借方" | "貸方">(prefix: P) =>
  ({
    account: `${prefix}勘定科目`,
    subAccount: `${prefix}補助科目名`,
    amount: `${prefix}金額`,
    taxCategory: `${prefix}税区分`,
    taxAmount: `${prefix}税金額`,
    partner: `${prefix}取引先名`,
    memo: `${prefix}メモ`,
    remarks: `${prefix}備考`,
  }) as const;

/** 仕訳帳の列。1行に借方と貸方の両方を持つ */
export const JOURNAL_COLUMNS = {
  date: "取引日",
  journalId: "仕訳ID",
  journalNo: "仕訳番号",
  lineNo: "仕訳行番号",
  lineCount: "仕訳行数",
  adjustment: "決算整理仕訳",
  entryMethod: "登録した方法",
  description: "取引内容",
  debit: sideColumns("借方"),
  credit: sideColumns("貸方"),
} as const;

/** 総勘定元帳の列 */
export const LEDGER_COLUMNS = {
  account: "勘定科目",
  date: "取引日",
  adjustment: "決算整理仕訳",
  counterpart: "相手勘定科目",
  journalNo: "仕訳番号",
  debit: "借方金額",
  credit: "貸方金額",
  balance: "残高",
} as const;

const { debit, credit, ...journalCommon } = JOURNAL_COLUMNS;

/** 仕訳帳で必要な列名の一覧 */
export const JOURNAL_COLUMN_NAMES: readonly string[] = [
  ...Object.values(journalCommon),
  ...Object.values(debit),
  ...Object.values(credit),
];

/** 総勘定元帳で必要な列名の一覧 */
export const LEDGER_COLUMN_NAMES: readonly string[] = Object.values(LEDGER_COLUMNS);
