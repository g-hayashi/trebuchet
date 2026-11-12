import {
  type BalanceSheet,
  CASH_AND_DEPOSIT_CODES,
  type HomeFigures,
  type HomeRecentJournal,
  type InvoiceSummary,
  type ProfitAndLoss,
  type StatementBatch,
} from "@trebuchet/schema";
import { sectionTotal } from "../reports/common.ts";
import type { FiscalPeriod, Journal } from "../types.ts";

// 011 US1: ホームの要約の純関数（research R3、data-model §2.1）。帳票と同じ関数が作った損益計算書・貸借対照表から
// 値を取るので、帳票と一致する（INV-72）

/** 未入金（`unpaid`・`partial`）の請求書の件数と、そのうち期限切れの件数。取消・全額入金は数えない */
export function countInvoiceTasks(invoices: readonly InvoiceSummary[]): {
  unpaidInvoices: number;
  overdueInvoices: number;
} {
  const open = invoices.filter((i) => i.status === "unpaid" || i.status === "partial");
  return { unpaidInvoices: open.length, overdueInvoices: open.filter((i) => i.overdue).length };
}

/** 未取消の請求書の残額の合計（未回収） */
export const outstandingTotal = (invoices: readonly InvoiceSummary[]): number =>
  invoices.reduce((sum, i) => sum + i.remaining, 0);

/** 貸借対照表の現金・預金の科目（`CASH_AND_DEPOSIT_CODES`）の行の合計 */
export function cashAndDeposits(balanceSheet: Pick<BalanceSheet, "sections">): number {
  return balanceSheet.sections
    .flatMap((s) => s.rows)
    .filter((r) => CASH_AND_DEPOSIT_CODES.includes(r.code))
    .reduce((sum, r) => sum + r.amount, 0);
}

/**
 * 今期の数字。`profitAndLoss` は会計期間の期首〜期末、`balanceSheet` は今日時点。
 * 売上 = `PL_SALES`、経費 = `PL_COGS` + `PL_EXPENSE`、利益 = `netIncome`（青色申告特別控除の前）
 */
export function homeFigures(input: {
  period: Pick<FiscalPeriod, "fiscalYear" | "startDate" | "endDate">;
  profitAndLoss: ProfitAndLoss;
  balanceSheet: BalanceSheet;
  outstanding: number;
}): HomeFigures {
  const { period, profitAndLoss: pl } = input;
  return {
    fiscalYear: period.fiscalYear,
    from: period.startDate,
    to: period.endDate,
    sales: sectionTotal(pl.sections, "PL_SALES"),
    expenses: sectionTotal(pl.sections, "PL_COGS") + sectionTotal(pl.sections, "PL_EXPENSE"),
    netIncome: pl.netIncome.amount,
    cashAndDeposits: cashAndDeposits(input.balanceSheet),
    outstanding: input.outstanding,
  };
}

/** 最近の仕訳の 1 件。金額は借方の合計 */
export function recentJournalOf(journal: Journal): HomeRecentJournal {
  return {
    id: journal.id,
    number: journal.journalNo,
    date: journal.date,
    memo: journal.memo,
    amount: journal.lines.filter((l) => l.side === "debit").reduce((sum, l) => sum + l.amount, 0),
    createdAt: journal.createdAt,
  };
}

/** 取込の回の `createdAt` の最大。なければ null */
export function lastImportAt(batches: readonly Pick<StatementBatch, "createdAt">[]): string | null {
  return batches.reduce<string | null>(
    (latest, b) => (latest === null || b.createdAt > latest ? b.createdAt : latest),
    null,
  );
}
