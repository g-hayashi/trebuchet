import {
  getBalanceSheet,
  getGeneralLedger,
  getJournalBook,
  getProfitAndLoss,
  getTrialBalance,
  toCsv,
} from "@trebuchet/domain";
import {
  BalanceSheetQuery,
  GeneralLedgerQuery,
  JournalBookQuery,
  ProfitAndLossQuery,
  type Report,
  TrialBalanceQuery,
} from "@trebuchet/schema";
import type { Context } from "hono";
import { Hono } from "hono";
import { reportDeps } from "../deps.ts";
import { respond } from "../errors.ts";
import { csvResponse } from "../lib/csv-response.ts";
import type { TenantEnv } from "../tenant.ts";
import { validate } from "../validator.ts";

/** FR-032: BOM 付き UTF-8 の CSV をダウンロードさせる */
function csv(c: Context, report: Report, suffix: string) {
  return csvResponse(c, toCsv(report), `${report.kind}-${suffix}.csv`);
}

/** `/api/entities/:entityId` の下の帳票（FR-026〜033）。format=csv なら CSV を返す */
export const reportRoutes = new Hono<TenantEnv>()
  .get("/reports/journal-book", validate("query", JournalBookQuery), (c) => {
    const { format, ...range } = c.req.valid("query");
    const result = getJournalBook(reportDeps(c.var.db), range);
    return respond(c, result, (report) =>
      format === "csv" ? csv(c, report, `${range.from}_${range.to}`) : c.json(report, 200),
    );
  })
  .get("/reports/general-ledger", validate("query", GeneralLedgerQuery), (c) => {
    const { format, ...params } = c.req.valid("query");
    const result = getGeneralLedger(reportDeps(c.var.db), params);
    return respond(c, result, (report) =>
      format === "csv"
        ? csv(c, report, `${report.account.code}_${params.from}_${params.to}`)
        : c.json(report, 200),
    );
  })
  .get("/reports/trial-balance", validate("query", TrialBalanceQuery), (c) => {
    const { format, ...range } = c.req.valid("query");
    const result = getTrialBalance(reportDeps(c.var.db), range);
    return respond(c, result, (report) =>
      format === "csv" ? csv(c, report, `${range.from}_${range.to}`) : c.json(report, 200),
    );
  })
  .get("/reports/profit-and-loss", validate("query", ProfitAndLossQuery), (c) => {
    const { format, ...params } = c.req.valid("query");
    const result = getProfitAndLoss(reportDeps(c.var.db), params);
    return respond(c, result, (report) =>
      format === "csv" ? csv(c, report, `${params.from}_${params.to}`) : c.json(report, 200),
    );
  })
  .get("/reports/balance-sheet", validate("query", BalanceSheetQuery), (c) => {
    const { format, ...params } = c.req.valid("query");
    const result = getBalanceSheet(reportDeps(c.var.db), params);
    return respond(c, result, (report) =>
      format === "csv" ? csv(c, report, params.asOf) : c.json(report, 200),
    );
  });
