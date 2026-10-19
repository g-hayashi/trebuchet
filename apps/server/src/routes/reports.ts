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
import { fail } from "../errors.ts";
import type { TenantEnv } from "../tenant.ts";
import { validate } from "../validator.ts";

/**
 * FR-032: BOM 付き UTF-8 の CSV をダウンロードさせる。
 * c.text にするのは、クライアントの型で JSON の応答と区別するため（Content-Type は上書きする）
 */
function csv(c: Context, report: Report, suffix: string) {
  return c.text(toCsv(report), 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${report.kind}-${suffix}.csv"`,
  });
}

/** `/api/entities/:entityId` の下の帳票（FR-026〜033）。format=csv なら CSV を返す */
export const reportRoutes = new Hono<TenantEnv>()
  .get("/reports/journal-book", validate("query", JournalBookQuery), (c) => {
    const { format, ...range } = c.req.valid("query");
    const result = getJournalBook(reportDeps(c.var.db), range);
    if (!result.ok) return fail(c, result.error);
    if (format === "csv") return csv(c, result.value, `${range.from}_${range.to}`);
    return c.json(result.value, 200);
  })
  .get("/reports/general-ledger", validate("query", GeneralLedgerQuery), (c) => {
    const { format, ...params } = c.req.valid("query");
    const result = getGeneralLedger(reportDeps(c.var.db), params);
    if (!result.ok) return fail(c, result.error);
    if (format === "csv") {
      return csv(c, result.value, `${result.value.account.code}_${params.from}_${params.to}`);
    }
    return c.json(result.value, 200);
  })
  .get("/reports/trial-balance", validate("query", TrialBalanceQuery), (c) => {
    const { format, ...range } = c.req.valid("query");
    const result = getTrialBalance(reportDeps(c.var.db), range);
    if (!result.ok) return fail(c, result.error);
    if (format === "csv") return csv(c, result.value, `${range.from}_${range.to}`);
    return c.json(result.value, 200);
  })
  .get("/reports/profit-and-loss", validate("query", ProfitAndLossQuery), (c) => {
    const { format, ...params } = c.req.valid("query");
    const result = getProfitAndLoss(reportDeps(c.var.db), params);
    if (!result.ok) return fail(c, result.error);
    if (format === "csv") return csv(c, result.value, `${params.from}_${params.to}`);
    return c.json(result.value, 200);
  })
  .get("/reports/balance-sheet", validate("query", BalanceSheetQuery), (c) => {
    const { format, ...params } = c.req.valid("query");
    const result = getBalanceSheet(reportDeps(c.var.db), params);
    if (!result.ok) return fail(c, result.error);
    if (format === "csv") return csv(c, result.value, params.asOf);
    return c.json(result.value, 200);
  });
