import type {
  BalanceSheet,
  GeneralLedger,
  JournalBook,
  ProfitAndLoss,
  ReportCompare,
  TrialBalance,
} from "@trebuchet/schema";
import type { MasterRepository, ReportRepository } from "../ports.ts";
import { buildBalanceSheet, compareBalanceSheet } from "../reports/balance-sheet.ts";
import { computeBalances } from "../reports/balances.ts";
import { shiftYears } from "../reports/common.ts";
import { buildGeneralLedger } from "../reports/general-ledger.ts";
import { buildJournalBook } from "../reports/journal-book.ts";
import { buildProfitAndLoss, compareProfitAndLoss } from "../reports/profit-and-loss.ts";
import { buildTrialBalance } from "../reports/trial-balance.ts";
import { detectWarnings } from "../reports/warnings.ts";
import {
  type Account,
  type DomainWarning,
  domainError,
  err,
  type FiscalPeriod,
  type OpeningBalance,
  ok,
  type PostedLine,
  type Result,
} from "../types.ts";

export type ReportDeps = { masters: MasterRepository; reports: ReportRepository };

export type WithWarnings<R> = R & { warnings: DomainWarning[] };

export type ReportRange = { from: string; to: string };

const periodOf = (date: string, periods: readonly FiscalPeriod[]) =>
  periods.find((p) => p.startDate <= date && date <= p.endDate);

const outOfPeriod = (date: string) =>
  err(domainError("OUT_OF_PERIOD", "会計期間が登録されていない日付です", { date }));

/** 期間を含む会計期間（from〜to が 1 つの会計期間に収まること） */
function resolvePeriod(deps: ReportDeps, range: ReportRange): Result<FiscalPeriod> {
  const period = periodOf(range.from, deps.masters.listFiscalPeriods());
  if (period === undefined) return outOfPeriod(range.from);
  if (range.to > period.endDate) {
    return err(
      domainError("VALIDATION", "期間は1つの会計期間の中で指定してください", {
        fiscalYear: period.fiscalYear,
        endDate: period.endDate,
      }),
    );
  }
  return ok(period);
}

/** 会計期間の期首残高と、会計期間の開始日から to までの有効な仕訳の行 */
type PeriodData = {
  period: FiscalPeriod;
  accounts: Account[];
  opening: OpeningBalance[];
  lines: PostedLine[];
};

function loadPeriod(
  deps: ReportDeps,
  period: FiscalPeriod,
  to: string,
  from = period.startDate,
): PeriodData {
  return {
    period,
    accounts: deps.masters.listAccounts(),
    opening: deps.reports.openingBalances(period.fiscalYear),
    lines: deps.reports.linesInRange(from, to),
  };
}

/** FR-033: 基準日（to）の残高と期首残高の登録の有無から警告を作る */
function warningsOf(data: PeriodData, to: string): DomainWarning[] {
  const balances = computeBalances({
    opening: data.opening,
    lines: data.lines,
    periodStart: data.period.startDate,
    to,
  });
  return detectWarnings(balances, data.accounts, {
    fiscalYear: data.period.fiscalYear,
    openingRegistered: data.opening.length > 0,
  });
}

/** 仕訳帳（FR-026）。会計期間をまたいでよい。警告は to を含む会計期間で判定する */
export function getJournalBook(
  deps: ReportDeps,
  range: ReportRange,
): Result<WithWarnings<JournalBook>> {
  const period = periodOf(range.to, deps.masters.listFiscalPeriods());
  if (period === undefined) {
    const book = buildJournalBook({
      ...range,
      lines: deps.reports.linesInRange(range.from, range.to),
    });
    return ok({ ...book, warnings: [] });
  }
  // 警告の残高のため、会計期間の開始日からの行も読む
  const start = period.startDate < range.from ? period.startDate : range.from;
  const data = loadPeriod(deps, period, range.to, start);
  return ok({
    ...buildJournalBook({ ...range, lines: data.lines }),
    warnings: warningsOf(data, range.to),
  });
}

/** 残高試算表（FR-028） */
export function getTrialBalance(
  deps: ReportDeps,
  range: ReportRange,
): Result<WithWarnings<TrialBalance>> {
  const period = resolvePeriod(deps, range);
  if (!period.ok) return period;
  const data = loadPeriod(deps, period.value, range.to);
  const report = buildTrialBalance({ ...data, periodStart: data.period.startDate, ...range });
  return ok({ ...report, warnings: warningsOf(data, range.to) });
}

export type GeneralLedgerParams = ReportRange & {
  accountId: string;
  subAccountId?: string | undefined;
};

/** 総勘定元帳（FR-027）。補助科目を指定すると、その補助科目だけで計算する */
export function getGeneralLedger(
  deps: ReportDeps,
  params: GeneralLedgerParams,
): Result<WithWarnings<GeneralLedger>> {
  if (deps.masters.getAccount(params.accountId) === undefined) {
    return err(
      domainError("ACCOUNT_NOT_FOUND", "勘定科目が見つかりません", { accountId: params.accountId }),
    );
  }
  let subAccount: { id: string; name: string } | null = null;
  if (params.subAccountId !== undefined) {
    const sub = deps.masters
      .listSubAccounts(params.accountId)
      .find((s) => s.id === params.subAccountId);
    if (sub === undefined) {
      return err(
        domainError("VALIDATION", "補助科目がその科目に属していません", {
          accountId: params.accountId,
          subAccountId: params.subAccountId,
        }),
      );
    }
    subAccount = { id: sub.id, name: sub.name };
  }
  const range = { from: params.from, to: params.to };
  const period = resolvePeriod(deps, range);
  if (!period.ok) return period;
  const data = loadPeriod(deps, period.value, range.to);
  const report = buildGeneralLedger({
    ...data,
    ...range,
    periodStart: data.period.startDate,
    accountId: params.accountId,
    subAccount,
  });
  return ok({ ...report, warnings: warningsOf(data, range.to) });
}

export type StatementOptions = { compare?: ReportCompare | undefined };

/** 損益計算書（FR-029）。compare=previous-year なら 1 年前の同じ範囲と比べる（FR-030） */
export function getProfitAndLoss(
  deps: ReportDeps,
  params: ReportRange & StatementOptions,
): Result<WithWarnings<ProfitAndLoss>> {
  const range = { from: params.from, to: params.to };
  const period = resolvePeriod(deps, range);
  if (!period.ok) return period;
  const data = loadPeriod(deps, period.value, range.to);
  let report = buildProfitAndLoss({ ...data, ...range });
  if (params.compare === "previous-year") {
    const previous = { from: shiftYears(range.from, -1), to: shiftYears(range.to, -1) };
    const lines = deps.reports.linesInRange(previous.from, previous.to);
    report = compareProfitAndLoss(
      report,
      buildProfitAndLoss({ accounts: data.accounts, lines, ...previous }),
      data.accounts,
    );
  }
  return ok({ ...report, warnings: warningsOf(data, range.to) });
}

/** 貸借対照表（FR-029）。compare=previous-year なら 1 年前の同じ日と比べる（FR-030） */
export function getBalanceSheet(
  deps: ReportDeps,
  params: { asOf: string } & StatementOptions,
): Result<WithWarnings<BalanceSheet>> {
  const periods = deps.masters.listFiscalPeriods();
  const period = periodOf(params.asOf, periods);
  if (period === undefined) return outOfPeriod(params.asOf);
  const data = loadPeriod(deps, period, params.asOf);
  let report = buildBalanceSheet({ ...data, periodStart: period.startDate, asOf: params.asOf });
  if (params.compare === "previous-year") {
    const asOf = shiftYears(params.asOf, -1);
    const prevPeriod = periodOf(asOf, periods);
    // 前年の会計期間がなければ、前年の値はすべて 0
    const previous =
      prevPeriod === undefined
        ? { accounts: data.accounts, opening: [], lines: [], periodStart: asOf }
        : { ...loadPeriod(deps, prevPeriod, asOf), periodStart: prevPeriod.startDate };
    report = compareBalanceSheet(report, buildBalanceSheet({ ...previous, asOf }), data.accounts);
  }
  return ok({ ...report, warnings: warningsOf(data, params.asOf) });
}
