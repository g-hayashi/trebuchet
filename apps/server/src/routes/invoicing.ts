import {
  type Clock,
  deleteBillingTerms,
  draftInvoices,
  getInvoiceDetail,
  getInvoiceSettings,
  getJournalOrigin,
  getWorkHours,
  issueInvoice,
  listBillingTerms,
  listInvoices,
  saveBillingTerms,
  saveInvoiceSettings,
  saveWorkHours,
  voidInvoice,
} from "@trebuchet/domain";
import {
  BillingTermsInput,
  InvoiceDraftRequest,
  InvoiceInput,
  InvoiceListQuery,
  InvoiceSettingsInput,
  InvoicingVoidInput,
  WorkHoursInput,
  WorkHoursQuery,
} from "@trebuchet/schema";
import { Hono } from "hono";
import { invoicingDeps } from "../deps.ts";
import { fail } from "../errors.ts";
import { todayOf } from "../lib/today.ts";
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

      // ---- 工数（US1。§3.1・§3.2） ----
      .get("/work-hours", validate("query", WorkHoursQuery), (c) => {
        const result = getWorkHours(deps(c.var.db), c.req.valid("query").month);
        if (!result.ok) return fail(c, result.error);
        return c.json({ entries: result.value }, 200);
      })
      .put(
        "/work-hours/:month",
        validate("param", WorkHoursQuery),
        validate("json", WorkHoursInput),
        (c) => {
          const result = saveWorkHours(
            deps(c.var.db),
            c.req.valid("param").month,
            c.req.valid("json"),
          );
          if (!result.ok) return fail(c, result.error);
          return c.json({ entries: result.value }, 200);
        },
      )

      // ---- 請求書の案（US1。§3.3）。保存しない ----
      .post("/invoices/drafts", validate("json", InvoiceDraftRequest), (c) => {
        const result = draftInvoices(deps(c.var.db), c.req.valid("json"), todayOf(clock));
        if (!result.ok) return fail(c, result.error);
        return c.json(result.value, 200);
      })

      // ---- 発行・詳細（US1。§3.4・§3.6） ----
      .post("/invoices", validate("json", InvoiceInput), (c) => {
        const result = issueInvoice(deps(c.var.db), c.req.valid("json"), todayOf(clock));
        if (!result.ok) return fail(c, result.error);
        return c.json(result.value, 201);
      })
      // 一覧の基本形（US1。§3.5）。`status` の絞り込み・期限切れ・未回収の合計は US2（T018）
      .get("/invoices", validate("query", InvoiceListQuery), (c) => {
        const { partnerId, month } = c.req.valid("query");
        const result = listInvoices(deps(c.var.db), { partnerId, month }, todayOf(clock));
        if (!result.ok) return fail(c, result.error);
        return c.json(result.value, 200);
      })
      .get("/invoices/:invoiceId", (c) => {
        const result = getInvoiceDetail(deps(c.var.db), c.req.param("invoiceId"), todayOf(clock));
        if (!result.ok) return fail(c, result.error);
        return c.json(result.value, 200);
      })

      // ---- 取消（US1。§3.7） ----
      .post("/invoices/:invoiceId/void", validate("json", InvoicingVoidInput), (c) => {
        const result = voidInvoice(
          deps(c.var.db),
          c.req.param("invoiceId"),
          c.req.valid("json"),
          todayOf(clock),
        );
        if (!result.ok) return fail(c, result.error);
        return c.json(result.value, 200);
      })

      // ---- 仕訳の出所（§6.1） ----
      .get("/journals/:journalId/origin", (c) => {
        const result = getJournalOrigin(deps(c.var.db), c.req.param("journalId"));
        if (!result.ok) return fail(c, result.error);
        return c.json({ origin: result.value }, 200);
      })
  );
}
