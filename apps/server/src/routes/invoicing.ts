import {
  deleteBillingTerms,
  draftInvoices,
  getInvoiceDetail,
  getInvoiceSettings,
  getJournalOrigin,
  getWorkHours,
  issueInvoice,
  listBillingTerms,
  listInvoices,
  previewInvoiceCalculation,
  recordPayment,
  saveBillingTerms,
  saveInvoiceSettings,
  saveWorkHours,
  voidInvoice,
  voidPayment,
} from "@trebuchet/domain";
import {
  BillingTermsInput,
  InvoiceCalculationInput,
  InvoiceDraftRequest,
  InvoiceInput,
  InvoiceListQuery,
  InvoiceSettingsInput,
  InvoicingVoidInput,
  PaymentInput,
  WorkHoursInput,
  WorkHoursQuery,
} from "@trebuchet/schema";
import { Hono } from "hono";
import { invoicingDeps, type RouteOptions } from "../deps.ts";
import { respond } from "../errors.ts";
import { todayOf } from "../lib/today.ts";
import type { TenantEnv } from "../tenant.ts";
import { validate } from "../validator.ts";

/**
 * `/api/entities/:entityId` の下の請求書（005 US1・US2・US4）。
 * `clock` は更新日時と「今日」（`todayOf`。R22）の元になる
 */
export function invoicingRoutes({ clock }: RouteOptions) {
  const deps = (db: TenantEnv["Variables"]["db"]) => invoicingDeps(db, clock);

  return (
    new Hono<TenantEnv>()
      // ---- 発行者の設定（US4。§2.1・§2.2） ----
      .get("/invoice-settings", (c) => {
        const result = getInvoiceSettings(deps(c.var.db));
        return respond(c, result, (settings) => c.json(settings, 200));
      })
      .put("/invoice-settings", validate("json", InvoiceSettingsInput), (c) => {
        const result = saveInvoiceSettings(deps(c.var.db), c.req.valid("json"));
        return respond(c, result, (settings) => c.json({ settings }, 200));
      })

      // ---- 請求の条件（US4。§2.3〜§2.5） ----
      .get("/billing-terms", (c) => {
        const result = listBillingTerms(deps(c.var.db));
        return respond(c, result, (terms) => c.json({ terms }, 200));
      })
      .put("/partners/:partnerId/billing-terms", validate("json", BillingTermsInput), (c) => {
        const result = saveBillingTerms(
          deps(c.var.db),
          c.req.param("partnerId"),
          c.req.valid("json"),
        );
        return respond(c, result, (terms) => c.json({ terms }, 200));
      })
      .delete("/partners/:partnerId/billing-terms", (c) => {
        const result = deleteBillingTerms(deps(c.var.db), c.req.param("partnerId"));
        return respond(c, result, () => c.body(null, 204));
      })

      // ---- 工数（US1。§3.1・§3.2） ----
      .get("/work-hours", validate("query", WorkHoursQuery), (c) => {
        const result = getWorkHours(deps(c.var.db), c.req.valid("query").month);
        return respond(c, result, (entries) => c.json({ entries }, 200));
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
          return respond(c, result, (entries) => c.json({ entries }, 200));
        },
      )

      // ---- 請求書の案（US1。§3.3）。保存しない ----
      .post("/invoices/drafts", validate("json", InvoiceDraftRequest), (c) => {
        const result = draftInvoices(deps(c.var.db), c.req.valid("json"), todayOf(clock));
        return respond(c, result, (drafts) => c.json(drafts, 200));
      })

      // ---- 発行・詳細（US1。§3.4・§3.6） ----
      .post("/invoices/calculate", validate("json", InvoiceCalculationInput), (c) => {
        const result = previewInvoiceCalculation(c.req.valid("json"));
        return respond(c, result, (amounts) => c.json(amounts, 200));
      })
      .post("/invoices", validate("json", InvoiceInput), (c) => {
        const result = issueInvoice(deps(c.var.db), c.req.valid("json"), todayOf(clock));
        return respond(c, result, (issued) => c.json(issued, 201));
      })
      // 一覧（§3.5）。期限切れ・`status` の絞り込み・取引先ごとの未回収は「今日」で決まる
      .get("/invoices", validate("query", InvoiceListQuery), (c) => {
        const result = listInvoices(deps(c.var.db), c.req.valid("query"), todayOf(clock));
        return respond(c, result, (list) => c.json(list, 200));
      })
      .get("/invoices/:invoiceId", (c) => {
        const result = getInvoiceDetail(deps(c.var.db), c.req.param("invoiceId"), todayOf(clock));
        return respond(c, result, (detail) => c.json(detail, 200));
      })

      // ---- 取消（US1。§3.7） ----
      .post("/invoices/:invoiceId/void", validate("json", InvoicingVoidInput), (c) => {
        const result = voidInvoice(
          deps(c.var.db),
          c.req.param("invoiceId"),
          c.req.valid("json"),
          todayOf(clock),
        );
        return respond(c, result, (voided) => c.json(voided, 200));
      })

      // ---- 入金の消し込み（US2。§4.1・§4.2） ----
      .post("/invoices/:invoiceId/payments", validate("json", PaymentInput), (c) => {
        const result = recordPayment(
          deps(c.var.db),
          c.req.param("invoiceId"),
          c.req.valid("json"),
          todayOf(clock),
        );
        return respond(c, result, (recorded) => c.json(recorded, 201));
      })
      .post(
        "/invoices/:invoiceId/payments/:paymentId/void",
        validate("json", InvoicingVoidInput),
        (c) => {
          const result = voidPayment(
            deps(c.var.db),
            c.req.param("invoiceId"),
            c.req.param("paymentId"),
            c.req.valid("json"),
            todayOf(clock),
          );
          return respond(c, result, (voided) => c.json(voided, 200));
        },
      )

      // ---- 仕訳の出所（§6.1） ----
      .get("/journals/:journalId/origin", (c) => {
        const result = getJournalOrigin(deps(c.var.db), c.req.param("journalId"));
        return respond(c, result, (origin) => c.json({ origin }, 200));
      })
  );
}
