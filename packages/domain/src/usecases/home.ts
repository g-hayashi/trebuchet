import {
  HOME_RECENT_JOURNAL_COUNT,
  type HomeFigures,
  type HomeSummary,
  type HomeTasks,
  ReceiptQuery,
  type Section,
} from "@trebuchet/schema";
import {
  countInvoiceTasks,
  homeFigures,
  lastImportAt,
  outstandingTotal,
  recentJournalOf,
} from "../home/summary.ts";
import type { LedgerRepository, ReceiptUnitOfWork, StatementUnitOfWork } from "../ports.ts";
import { findPeriodByDate, ok, type Result } from "../types.ts";
import { type BlueReturnDeps, getBlueReturn } from "./blue-return.ts";
import { type InvoicingDeps, listInvoices } from "./invoicing.ts";
import { type RecurringDeps, recurringStatus } from "./recurring.ts";
import { getBalanceSheet, getProfitAndLoss } from "./reports.ts";
import { listStatementBatches, listStatements } from "./statements.ts";

// 011 US1: ホームの要約（research R3、data-model §2.1、contracts/http-api.md §1）。
// 項目ごとに既存のユースケース・ストアを呼んで組み立て、項目ごとに例外・`err` を `{ status: "error", code }` にする（FR-009）

export type HomeDeps = {
  statements: { uow: StatementUnitOfWork };
  receipts: { uow: ReceiptUnitOfWork };
  invoicing: Pick<InvoicingDeps, "uow">;
  recurring: Pick<RecurringDeps, "uow">;
  /** 帳票と決算書（今期の数字・決算書の警告）。帳票と同じ関数を同じ引数で呼ぶ（INV-72） */
  blueReturn: BlueReturnDeps;
  ledger: Pick<LedgerRepository, "recentRegistered">;
};

/** 項目の中の `err` を、その項目だけの失敗にするための例外 */
class SectionFailure extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/** `Result` の失敗はそのコード、想定外の例外は `INTERNAL` の失敗にする */
function section<T>(compute: () => T): Section<T> {
  try {
    return { status: "ok", value: compute() };
  } catch (e) {
    return { status: "error", code: e instanceof SectionFailure ? e.code : "INTERNAL" };
  }
}

const must = <T>(result: Result<T>): T => {
  if (!result.ok) throw new SectionFailure(result.error.code);
  return result.value;
};

const periodOn = (deps: HomeDeps, today: string) =>
  findPeriodByDate(deps.blueReturn.masters.listFiscalPeriods(), today);

/** 今日を含む会計期間の年の決算書の警告の件数。会計期間がない・個人の事業体でなければ 0 */
function blueReturnWarnings(deps: HomeDeps, today: string): number {
  const period = periodOn(deps, today);
  if (period === undefined) return 0;
  const result = getBlueReturn(deps.blueReturn, { fiscalYear: period.fiscalYear });
  if (!result.ok && result.error.code === "ENTITY_KIND_UNSUPPORTED") return 0;
  return must(result).warnings.length;
}

function tasksOf(deps: HomeDeps, today: string): HomeTasks {
  const unprocessedStatements = must(
    listStatements(deps.statements, { status: "unprocessed" }),
  ).length;
  const unlinkedReceipts = must(
    deps.receipts.uow.run((tx) => ok(tx.receipts.count(ReceiptQuery.parse({ link: "none" })))),
  );
  const invoices = must(listInvoices(deps.invoicing, {}, today)).invoices;
  const blockedRecurring = must(recurringStatus(deps.recurring, today)).blocked.length;
  return {
    unprocessedStatements,
    unlinkedReceipts,
    ...countInvoiceTasks(invoices),
    blockedRecurring,
    blueReturnWarnings: blueReturnWarnings(deps, today),
  };
}

function figuresOf(deps: HomeDeps, today: string): HomeFigures | null {
  const period = periodOn(deps, today);
  if (period === undefined) return null;
  const profitAndLoss = must(
    getProfitAndLoss(deps.blueReturn, { from: period.startDate, to: period.endDate }),
  );
  const balanceSheet = must(getBalanceSheet(deps.blueReturn, { asOf: today }));
  const outstanding = outstandingTotal(must(listInvoices(deps.invoicing, {}, today)).invoices);
  return homeFigures({ period, profitAndLoss, balanceSheet, outstanding });
}

/**
 * ホームの要約。`today`（`YYYY-MM-DD`）は server が `todayOf(clock)` で作る。
 * 項目（今日やること・今期の数字・最近の仕訳・最後の明細の取込）ごとに成否を持ち、1 項目の失敗でほかを失わない
 */
export function getHomeSummary(deps: HomeDeps, today: string): HomeSummary {
  return {
    tasks: section(() => tasksOf(deps, today)),
    figures: section(() => figuresOf(deps, today)),
    recentJournals: section(() =>
      deps.ledger.recentRegistered(HOME_RECENT_JOURNAL_COUNT).map(recentJournalOf),
    ),
    lastStatementImportAt: section(() => lastImportAt(must(listStatementBatches(deps.statements)))),
  };
}
