import {
  type Clock,
  deleteBillingTerms,
  getInvoiceSettings,
  listBillingTerms,
  saveBillingTerms,
  saveInvoiceSettings,
} from "@trebuchet/domain";
import { BillingTermsInput, InvoiceSettingsInput } from "@trebuchet/schema";
import { Hono } from "hono";
import { invoicingDeps } from "../deps.ts";
import { fail } from "../errors.ts";
import type { TenantEnv } from "../tenant.ts";
import { validate } from "../validator.ts";

/**
 * `/api/entities/:entityId` の下の請求書（005 US1・US2・US4）。
 * `clock` は更新日時と「今日」（`todayOf`。R22）の元になる
 */
export function invoicingRoutes(options: { clock: Clock }) {
  const { clock } = options;
  const deps = (db: TenantEnv["Variables"]["db"]) => {
    const { uow, ids } = invoicingDeps(db);
    return { uow, ids, clock };
  };

  return (
    new Hono<TenantEnv>()
      // ---- 発行者の設定（US4。§2.1・§2.2） ----
      .get("/invoice-settings", (c) => {
        const result = getInvoiceSettings(deps(c.var.db));
        if (!result.ok) return fail(c, result.error);
        return c.json(result.value, 200);
      })
      .put("/invoice-settings", validate("json", InvoiceSettingsInput), (c) => {
        const result = saveInvoiceSettings(deps(c.var.db), c.req.valid("json"));
        if (!result.ok) return fail(c, result.error);
        return c.json({ settings: result.value }, 200);
      })

      // ---- 請求の条件（US4。§2.3〜§2.5） ----
      .get("/billing-terms", (c) => {
        const result = listBillingTerms(deps(c.var.db));
        if (!result.ok) return fail(c, result.error);
        return c.json({ terms: result.value }, 200);
      })
      .put("/partners/:partnerId/billing-terms", validate("json", BillingTermsInput), (c) => {
        const result = saveBillingTerms(
          deps(c.var.db),
          c.req.param("partnerId"),
          c.req.valid("json"),
        );
        if (!result.ok) return fail(c, result.error);
        return c.json({ terms: result.value }, 200);
      })
      .delete("/partners/:partnerId/billing-terms", (c) => {
        const result = deleteBillingTerms(deps(c.var.db), c.req.param("partnerId"));
        if (!result.ok) return fail(c, result.error);
        return c.body(null, 204);
      })
  );
}
