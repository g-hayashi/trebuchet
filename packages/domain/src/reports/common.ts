import type { ReportAccount, StatementRow, StatementSection } from "@trebuchet/schema";
import { compareText } from "../text.ts";
import type { Account, PostedLine, ReportSection, Side } from "../types.ts";

/** 帳票の関数が受け取る期首残高（OpeningBalance の一部） */
export type OpeningInput = {
  accountId: string;
  subAccountId?: string | null | undefined;
  side: Side;
  amount: number;
};

/** 決算書の区分ごとの、金額を正とする側（事業主貸は資産の区分なので借方を正とする） */
export const SECTION_SIDE: Record<ReportSection, Side> = {
  BS_ASSET: "debit",
  BS_LIABILITY: "credit",
  BS_EQUITY: "credit",
  PL_SALES: "credit",
  PL_COGS: "debit",
  PL_EXPENSE: "debit",
  PL_OTHER: "credit",
};

export const PL_SECTIONS: readonly ReportSection[] = [
  "PL_SALES",
  "PL_COGS",
  "PL_EXPENSE",
  "PL_OTHER",
];
export const BS_SECTIONS: readonly ReportSection[] = ["BS_ASSET", "BS_LIABILITY", "BS_EQUITY"];

export const isBsSection = (section: ReportSection) => section.startsWith("BS_");

/** 借方を正とする金額を、side の側を正とする金額にする（-0 を作らない） */
export const toSide = (debitNet: number, side: Side) =>
  side === "debit" ? debitNet : 0 - debitNet;

/** 行の借方を正とする金額 */
export const debitNet = (line: { side: Side; amount: number }) =>
  line.side === "debit" ? line.amount : -line.amount;

/** INV-6: 帳票は取消済みの仕訳を含めない */
export const isActive = (line: PostedLine) => line.status === "active";

/** 決算書の科目順（sortOrder → コード） */
export function sortAccounts<A extends Pick<Account, "sortOrder" | "code">>(
  accounts: readonly A[],
): A[] {
  return [...accounts].sort((a, b) => a.sortOrder - b.sortOrder || compareText(a.code, b.code));
}

/** 科目 ID → 決算書の科目順の位置。一覧にない ID は最後 */
export function accountOrder(accounts: readonly Account[]): (accountId: string) => number {
  const order = new Map(sortAccounts(accounts).map((a, i) => [a.id, i]));
  return (accountId) => order.get(accountId) ?? Number.MAX_SAFE_INTEGER;
}

/** 行の金額の合計 */
export const sumAmounts = (rows: readonly { amount: number }[]): number =>
  rows.reduce((s, r) => s + r.amount, 0);

/** 区分（`PL_SALES` など）の合計。区分がなければ 0 */
export const sectionTotal = (sections: readonly StatementSection[], section: string): number =>
  sections.find((s) => s.section === section)?.total.amount ?? 0;

/** 日付 → 仕訳番号 → 行番号の順（分析メモ U4） */
export function compareLines(
  a: Pick<PostedLine, "date" | "journalNo" | "lineNo">,
  b: Pick<PostedLine, "date" | "journalNo" | "lineNo">,
): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  return a.journalNo - b.journalNo || a.lineNo - b.lineNo;
}

export const reportAccount = (a: Account): ReportAccount => ({
  accountId: a.id,
  code: a.code,
  name: a.name,
  category: a.category,
  normalSide: a.normalSide,
});

export const statementRow = (a: Account, amount: number): StatementRow => ({
  accountId: a.id,
  code: a.code,
  name: a.name,
  reportLine: a.reportLine,
  amount,
});

/** 区分の科目の行: 使用中の科目と、金額が 0 でない科目（科目順） */
export function sectionRows(
  accounts: readonly Account[],
  section: ReportSection,
  amountOf: (accountId: string) => number,
): StatementRow[] {
  return sortAccounts(accounts.filter((a) => a.reportSection === section))
    .map((a) => ({ account: a, amount: amountOf(a.id) }))
    .filter(({ account, amount }) => account.isActive || amount !== 0)
    .map(({ account, amount }) => statementRow(account, amount));
}
