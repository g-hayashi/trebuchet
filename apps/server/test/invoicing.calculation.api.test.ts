import { openTenant } from "@trebuchet/db";
import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { errorOf, TEST_HOST, TEST_ORIGIN } from "./helpers.ts";
import {
  createInvoicingTestContext,
  type InvoicingTestContext,
  okBody,
} from "./invoicing-helpers.ts";

let tmp: TempDataDir;
let ctx: InvoicingTestContext;
beforeEach(async () => {
  tmp = useTempDataDir("server-invoicing-calculation");
  ctx = await createInvoicingTestContext();
});
afterEach(() => tmp.cleanup());

describe("POST /invoices/calculate", () => {
  it("税率別端数と対象外を計算し、仕訳・請求・採番・監査を書かない", async () => {
    await ctx.setSettings();
    const db = openTenant(ctx.entityId);
    const counts = () =>
      ["journals", "invoices", "invoicing_audit_log"].map((table) =>
        db.$client.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(),
      );
    const before = counts();
    const res = await ctx.e.invoices.calculate.$post({
      param: ctx.param,
      json: {
        priceMode: "exclusive",
        items: [
          { amount: 9, taxRate: 10 },
          { amount: 9, taxRate: 10 },
          { amount: 13, taxRate: 8 },
          { amount: 13, taxRate: 8 },
          { amount: 5, taxRate: null },
        ],
      },
    });
    expect(res.status).toBe(200);
    expect(await okBody(res)).toEqual({
      subtotal: 49,
      total: 52,
      taxBreakdown: [
        { rate: 10, inclusive: 19, exclusive: 18, tax: 1 },
        { rate: 8, inclusive: 28, exclusive: 26, tax: 2 },
      ],
      withholdingBase: 0,
      withholdingTax: 0,
      netAmount: 52,
    });
    expect(counts()).toEqual(before);
    expect(db.$client.prepare("SELECT next_seq FROM invoice_settings").get()).toEqual({
      next_seq: 1,
    });
    const inclusive = await ctx.e.invoices.calculate.$post({
      param: ctx.param,
      json: { priceMode: "inclusive", items: [{ amount: 180000, taxRate: 10 }] },
    });
    expect(await okBody(inclusive)).toMatchObject({ subtotal: 180000, total: 180000 });
  });
  it("partnerId の取引先が「源泉徴収あり」なら、対象額・税額・差引を返す（013）", async () => {
    await ctx.setSettings({ taxDisplay: "separate" });
    const partnerId = await ctx.addPartner("合成取引先");
    await ctx.setTerms(partnerId, { withholding: true });
    const items = [{ amount: 330_000, taxRate: 10 as const }];
    const res = await ctx.e.invoices.calculate.$post({
      param: ctx.param,
      json: { priceMode: "inclusive", items, partnerId },
    });
    expect(res.status).toBe(200);
    expect(await okBody(res)).toMatchObject({
      total: 330_000,
      withholdingBase: 300_000,
      withholdingTax: 30_630,
      netAmount: 299_370,
    });
    // partnerId なしは源泉徴収なし
    const none = await ctx.e.invoices.calculate.$post({
      param: ctx.param,
      json: { priceMode: "inclusive", items },
    });
    expect(await okBody(none)).toMatchObject({ withholdingBase: 0, withholdingTax: 0 });
  });
  it("422 WITHHOLDING_RATE_MISSING: 発行日に税制の値がない（013）", async () => {
    await ctx.setSettings();
    const partnerId = await ctx.addPartner("合成取引先");
    await ctx.setTerms(partnerId, { withholding: true });
    const res = await ctx.e.invoices.calculate.$post({
      param: ctx.param,
      json: {
        priceMode: "inclusive",
        items: [{ amount: 330_000, taxRate: 10 }],
        partnerId,
        issueDate: "2048-01-05",
      },
    });
    expect(res.status).toBe(422);
    const error = await errorOf(res);
    expect(error.code).toBe("WITHHOLDING_RATE_MISSING");
    expect(error.details).toMatchObject({ date: "2048-01-05" });
  });
  it("入力不正・合計上限超過は400 VALIDATION", async () => {
    const bad = await ctx.e.invoices.calculate.$post({
      param: ctx.param,
      json: { priceMode: "exclusive", items: [] },
    });
    expect(bad.status).toBe(400);
    expect((await errorOf(bad)).code).toBe("VALIDATION");
    const high = await ctx.e.invoices.calculate.$post({
      param: ctx.param,
      json: { priceMode: "exclusive", items: [{ amount: 999999999999, taxRate: 10 }] },
    });
    expect(high.status).toBe(400);
    expect((await errorOf(high)).code).toBe("VALIDATION");
  });
  it("未認証は401、未登録の事業体は404", async () => {
    const app = createApp();
    const response = await app.request(`/api/entities/${ctx.entityId}/invoices/calculate`, {
      method: "POST",
      headers: { Host: TEST_HOST, Origin: TEST_ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ priceMode: "exclusive", items: [{ amount: 100, taxRate: 10 }] }),
    });
    expect(response.status).toBe(401);
    const missing = await ctx.e.invoices.calculate.$post({
      param: { entityId: "00000000-0000-7000-8000-000000000000" },
      json: { priceMode: "exclusive", items: [{ amount: 100, taxRate: 10 }] },
    });
    expect(missing.status).toBe(404);
  });
  it("発行→GETで方式と198000を保持し、設定変更で写しを変えない", async () => {
    await ctx.setSettings({ registrationNumber: "T1234567890123" });
    const partnerId = await ctx.addPartner("合成取引先");
    await ctx.setTerms(partnerId, { priceMode: "exclusive", taxRate: 10 });
    const terms = await okBody(await ctx.e["billing-terms"].$get({ param: ctx.param }));
    expect(terms.terms[0]).toMatchObject({ priceMode: "exclusive", taxRate: 10 });
    const issued = await ctx.e.invoices.$post({
      param: ctx.param,
      json: {
        partnerId,
        targetMonth: "2026-10",
        priceMode: "exclusive",
        items: [{ name: "業務", quantity: 30, unitPrice: 6000, amount: 180000, taxRate: 10 }],
      },
    });
    expect(issued.status).toBe(201);
    const body = await okBody(issued);
    expect(body.invoice).toMatchObject({
      priceMode: "exclusive",
      total: 198000,
      issuer: { registrationNumber: null },
    });
    expect(body.journal.lines.filter((l) => l.side === "credit")).toMatchObject([
      { amount: 198000, taxAmount: 0 },
    ]);
    await ctx.setTerms(partnerId, { priceMode: "inclusive", taxRate: 8 });
    await ctx.setSettings({ taxDisplay: "inclusive_only", nextSeq: 2 });
    const read = await ctx.e.invoices[":invoiceId"].$get({
      param: { ...ctx.param, invoiceId: body.invoice.id },
    });
    expect(await okBody(read)).toEqual(body.invoice);
  });
  it("課税の税区分省略は明示税率8/10/nullから導出し、明示矛盾は400で拒否", async () => {
    await ctx.setSettings();
    await ctx.makeTaxable();
    const partnerId = await ctx.addPartner("合成取引先");
    await ctx.setTerms(partnerId);
    const issued = await ctx.e.invoices.$post({
      param: ctx.param,
      json: {
        partnerId,
        targetMonth: "2026-10",
        priceMode: "exclusive",
        items: [
          { name: "A", amount: 100, taxRate: 8 },
          { name: "B", amount: 100, taxRate: 10 },
          { name: "C", amount: 100, taxRate: null },
        ],
      },
    });
    expect(issued.status).toBe(201);
    const body = await okBody(issued);
    expect(body.invoice.items.map((i) => i.taxCategory)).toEqual([
      "SALES_8R",
      "SALES_10",
      "OUT_OF_SCOPE",
    ]);
    expect(body.invoice.total).toBe(318);
    const conflict = await ctx.e.invoices.$post({
      param: ctx.param,
      json: {
        partnerId,
        targetMonth: "2026-11",
        priceMode: "exclusive",
        items: [{ name: "A", amount: 100, taxRate: 8, taxCategory: "SALES_10" }],
      },
    });
    expect(conflict.status).toBe(400);
    expect((await errorOf(conflict)).code).toBe("VALIDATION");
  });
});
