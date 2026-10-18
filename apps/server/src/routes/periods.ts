import {
  createNextFiscalPeriod,
  type DomainError,
  domainError,
  err,
  type FiscalPeriod,
  type MasterRepository,
  ok,
  type Result,
  replaceOpeningBalances,
} from "@trebuchet/domain";
import { OpeningBalancesPut } from "@trebuchet/schema";
import { Hono } from "hono";
import { masterDeps } from "../deps.ts";
import { fail } from "../errors.ts";
import type { TenantEnv } from "../tenant.ts";
import { validate } from "../validator.ts";

const yearError = (year: string): DomainError =>
  domainError("VALIDATION", "会計期間が見つかりません", { fiscalYear: year });

/** パスの `:year`（4桁の数字）を数値にする */
function parseYear(year: string): Result<number> {
  return /^\d{4}$/.test(year) ? ok(Number(year)) : err(yearError(year));
}

function findPeriod(repo: MasterRepository, year: string): Result<FiscalPeriod> {
  const parsed = parseYear(year);
  if (!parsed.ok) return parsed;
  const period = repo.getFiscalPeriodByYear(parsed.value);
  return period === undefined ? err(yearError(year)) : ok(period);
}

/** `/api/entities/:entityId` の下の会計期間・期首残高（FR-011, FR-012） */
export const periodRoutes = new Hono<TenantEnv>()
  .get("/fiscal-periods", (c) =>
    c.json({ fiscalPeriods: masterDeps(c.var.db).repo.listFiscalPeriods() }, 200),
  )
  .post("/fiscal-periods", (c) => {
    const result = createNextFiscalPeriod(masterDeps(c.var.db));
    if (!result.ok) return fail(c, result.error);
    return c.json({ fiscalPeriod: result.value }, 201);
  })
  .get("/fiscal-periods/:year/opening-balances", (c) => {
    const { repo } = masterDeps(c.var.db);
    const period = findPeriod(repo, c.req.param("year"));
    if (!period.ok) return fail(c, period.error);
    return c.json(
      { fiscalPeriod: period.value, openingBalances: repo.listOpeningBalances(period.value.id) },
      200,
    );
  })
  .put("/fiscal-periods/:year/opening-balances", validate("json", OpeningBalancesPut), (c) => {
    const deps = masterDeps(c.var.db);
    const year = parseYear(c.req.param("year"));
    if (!year.ok) return fail(c, year.error);
    const result = replaceOpeningBalances(deps, year.value, c.req.valid("json"));
    if (!result.ok) return fail(c, result.error);
    const period = findPeriod(deps.repo, c.req.param("year"));
    if (!period.ok) return fail(c, period.error);
    return c.json({ fiscalPeriod: period.value, openingBalances: result.value }, 200);
  });
