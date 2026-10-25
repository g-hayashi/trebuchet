import {
  closePeriod,
  createNextFiscalPeriod,
  err,
  type FiscalPeriod,
  getFiscalPeriodHistory,
  type MasterRepository,
  ok,
  periodNotFound,
  type Result,
  reopenPeriod,
  replaceOpeningBalances,
} from "@trebuchet/domain";
import { FiscalYearParam, OpeningBalancesPut, ReopenInput } from "@trebuchet/schema";
import { Hono } from "hono";
import { masterDeps, type RouteOptions } from "../deps.ts";
import { fail, respond } from "../errors.ts";
import type { TenantEnv } from "../tenant.ts";
import { validate } from "../validator.ts";

function findPeriod(repo: MasterRepository, year: number): Result<FiscalPeriod> {
  const period = repo.getFiscalPeriodByYear(year);
  return period === undefined ? err(periodNotFound(year)) : ok(period);
}

/** `/api/entities/:entityId` の下の会計期間・締め・期首残高（FR-011, FR-012, FR-024, FR-025） */
export function periodRoutes({ clock }: RouteOptions) {
  return new Hono<TenantEnv>()
    .get("/fiscal-periods", (c) =>
      c.json({ fiscalPeriods: masterDeps(c.var.db, clock).repo.listFiscalPeriods() }, 200),
    )
    .post("/fiscal-periods", (c) => {
      const result = createNextFiscalPeriod(masterDeps(c.var.db, clock));
      return respond(c, result, (fiscalPeriod) => c.json({ fiscalPeriod }, 201));
    })
    .get("/fiscal-periods/history", (c) =>
      c.json({ history: getFiscalPeriodHistory(masterDeps(c.var.db, clock)) }, 200),
    )
    .post("/fiscal-periods/:year/close", validate("param", FiscalYearParam), (c) => {
      const result = closePeriod(masterDeps(c.var.db, clock), c.req.valid("param").year);
      return respond(c, result, (fiscalPeriod) => c.json({ fiscalPeriod }, 200));
    })
    .post(
      "/fiscal-periods/:year/reopen",
      validate("param", FiscalYearParam),
      validate("json", ReopenInput),
      (c) => {
        const result = reopenPeriod(
          masterDeps(c.var.db, clock),
          c.req.valid("param").year,
          c.req.valid("json"),
        );
        return respond(c, result, (fiscalPeriod) => c.json({ fiscalPeriod }, 200));
      },
    )
    .get("/fiscal-periods/:year/opening-balances", validate("param", FiscalYearParam), (c) => {
      const { repo } = masterDeps(c.var.db, clock);
      const period = findPeriod(repo, c.req.valid("param").year);
      return respond(c, period, (fiscalPeriod) =>
        c.json({ fiscalPeriod, openingBalances: repo.listOpeningBalances(fiscalPeriod.id) }, 200),
      );
    })
    .put(
      "/fiscal-periods/:year/opening-balances",
      validate("param", FiscalYearParam),
      validate("json", OpeningBalancesPut),
      (c) => {
        const deps = masterDeps(c.var.db, clock);
        const { year } = c.req.valid("param");
        const result = replaceOpeningBalances(deps, year, c.req.valid("json"));
        if (!result.ok) return fail(c, result.error);
        const period = findPeriod(deps.repo, year);
        return respond(c, period, (fiscalPeriod) =>
          c.json({ fiscalPeriod, openingBalances: result.value }, 200),
        );
      },
    );
}
