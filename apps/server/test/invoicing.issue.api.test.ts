import { openTenant } from "@trebuchet/db";
import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { errorOf } from "./helpers.ts";
import {
  createInvoicingTestContext,
  type InvoicingTestContext,
  okBody,
  TODAY,
} from "./invoicing-helpers.ts";

// 005 US1: contracts/http-api.md §3.4・§3.6・§6.1（発行・詳細・仕訳の起点）

let tmp: TempDataDir;
let ctx: InvoicingTestContext;
let partnerId: string;

beforeEach(async () => {
  tmp = useTempDataDir("server-invoicing-issue");
  ctx = await createInvoicingTestContext();
  await ctx.setSettings({ nextSeq: 43 });
  partnerId = await ctx.addPartner("株式会社A", null);
  await ctx.setTerms(partnerId);
});
afterEach(() => tmp.cleanup());

type InvoiceJson = Parameters<InvoicingTestContext["e"]["invoices"]["$post"]>[0]["json"];

const body = (over: Record<string, unknown> = {}) =>
  ({
    partnerId,
    targetMonth: "2026-10",
    items: [
      {
        name: "10月分 業務委託",
        quantity: 120.5,
        unit: "時間",
        unitPrice: 10_000,
        amount: 1_205_000,
      },
    ],
    ...over,
  }) as InvoiceJson;

const issue = (over: Record<string, unknown> = {}) =>
  ctx.e.invoices.$post({ param: ctx.param, json: body(over) });
const detail = (invoiceId: string) =>
  ctx.e.invoices[":invoiceId"].$get({ param: { ...ctx.param, invoiceId } });
const originOf = (journalId: string) =>
  ctx.e.journals[":journalId"].origin.$get({ param: { ...ctx.param, journalId } });
const journals = async () =>
  (await okBody(await ctx.e.journals.$get({ param: ctx.param, query: {} }))).journals;
const nextSeq = async () =>
  (await okBody(await ctx.e["invoice-settings"].$get({ param: ctx.param }))).settings?.nextSeq;

describe("POST /invoices（§3.4。FR-008〜013）", () => {
  it("201 { invoice, journal }。番号 YYYYMMDD-043、売上の仕訳が 1 件、次の通し番号は 44", async () => {
    const res = await issue();
    expect(res.status).toBe(201);
    const { invoice, journal } = await okBody(res);
    expect(invoice).toMatchObject({
      invoiceNo: "20261031-043",
      partnerId,
      targetMonth: "2026-10",
      issueDate: TODAY,
      salesDate: "2026-10-31",
      dueDate: "2026-11-30",
      recipientName: "株式会社A",
      recipientHonorific: "御中",
      total: 1_205_000,
      status: "unpaid",
      paid: 0,
      remaining: 1_205_000,
      overdue: false,
      journalId: journal.id,
      payments: [],
    });
    expect(journal).toMatchObject({ date: "2026-10-31", memo: "請求書 20261031-043" });
    expect(journal.lines.map((l) => [l.side, l.amount, l.partnerId])).toEqual([
      ["debit", 1_205_000, partnerId],
      ["credit", 1_205_000, partnerId],
    ]);
    expect(await nextSeq()).toBe(44);
    const list = await journals();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: journal.id, source: "invoice" });
  });

  it("発行日・売上の計上日を指定できる（FR-009）", async () => {
    const res = await issue({ issueDate: "2026-11-05", salesDate: "2026-11-02" });
    expect(res.status).toBe(201);
    const { invoice, journal } = await okBody(res);
    expect(invoice).toMatchObject({
      invoiceNo: "20261105-043",
      issueDate: "2026-11-05",
      salesDate: "2026-11-02",
      dueDate: "2026-11-30",
    });
    expect(journal.date).toBe("2026-11-02");
  });

  it("同じ取引先・対象月は 409 INVOICE_DUPLICATE_MONTH（details.invoices）。confirmDuplicate で発行できる", async () => {
    expect((await issue()).status).toBe(201);
    const dup = await issue();
    expect(dup.status).toBe(409);
    const error = await errorOf(dup);
    expect(error.code).toBe("INVOICE_DUPLICATE_MONTH");
    expect(error.details).toMatchObject({ invoices: ["20261031-043"] });
    expect(await journals()).toHaveLength(1);

    const confirmed = await issue({ confirmDuplicate: true });
    expect(confirmed.status).toBe(201);
    expect((await okBody(confirmed)).invoice.invoiceNo).toBe("20261031-044");
  });

  it("締め済みの計上日は 409 PERIOD_CLOSED。仕訳も請求書も残らず、番号も進まない", async () => {
    const close = await ctx.e["fiscal-periods"][":year"].close.$post({
      param: { ...ctx.param, year: "2026" },
    });
    expect(close.status).toBe(200);
    const res = await issue();
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe("PERIOD_CLOSED");
    expect(await journals()).toHaveLength(0);
    expect(await nextSeq()).toBe(43);
  });

  it("会計期間の外の計上日は 422 OUT_OF_PERIOD", async () => {
    const res = await issue({ salesDate: "2030-01-31" });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe("OUT_OF_PERIOD");
  });

  it("発行者の設定が空なら 422 INVOICE_ISSUER_INCOMPLETE（details.fields）", async () => {
    await ctx.setSettings({ address: "", bankAccount: "" });
    const res = await issue();
    expect(res.status).toBe(422);
    const error = await errorOf(res);
    expect(error.code).toBe("INVOICE_ISSUER_INCOMPLETE");
    expect(error.details).toMatchObject({ fields: ["address", "bankAccount"] });
    expect(await journals()).toHaveLength(0);
  });

  it("消費税の設定の空白の計上日は 422 TAX_SETTING_GAP。仕訳も請求書も残らない", async () => {
    openTenant(ctx.entityId)
      .$client.prepare("UPDATE consumption_tax_settings SET effective_from = '2026-07-01'")
      .run();
    const res = await issue({ targetMonth: "2026-03" });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe("TAX_SETTING_GAP");
    expect(await journals()).toHaveLength(0);
    expect(await nextSeq()).toBe(43);
  });

  it("使用停止の取引先は 422 PARTNER_INACTIVE、条件のない取引先は 422 BILLING_TERMS_MISSING", async () => {
    // 取引先の使用停止の API はまだない。DB の列を直接変える
    openTenant(ctx.entityId)
      .$client.prepare("UPDATE partners SET is_active = 0 WHERE id = ?")
      .run(partnerId);
    const res = await issue();
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe("PARTNER_INACTIVE");

    const bare = await ctx.addPartner("条件なし");
    const noTerms = await issue({ partnerId: bare });
    expect(noTerms.status).toBe(422);
    expect((await errorOf(noTerms)).code).toBe("BILLING_TERMS_MISSING");
  });

  it("明細が数量 × 単価と一致しない・0 行・6 行・0.5 の倍数でない数量は 400 VALIDATION", async () => {
    const cases = [
      [{ name: "x", quantity: 1, unitPrice: 1000, amount: 999 }],
      [],
      Array.from({ length: 6 }, (_, i) => ({ name: `n${i}`, amount: 1 })),
      [{ name: "x", quantity: 1.25, unitPrice: 1000, amount: 1250 }],
    ];
    for (const items of cases) {
      const res = await issue({ items });
      expect(res.status).toBe(400);
      expect((await errorOf(res)).code).toBe("VALIDATION");
    }
    expect(await journals()).toHaveLength(0);
  });
});

describe("GET /invoices/:invoiceId（§3.6）", () => {
  it("状態・残額・写し・明細・別記の内訳を返す。ない請求書は 404 INVOICE_NOT_FOUND", async () => {
    await ctx.makeTaxable();
    const issued = await okBody(
      await issue({
        items: [
          { name: "開発", amount: 110_000 },
          { name: "教材", amount: 55_000, taxCategory: "SALES_8R" },
        ],
      }),
    );
    const res = await detail(issued.invoice.id);
    expect(res.status).toBe(200);
    const got = await okBody(res);
    expect(got).toMatchObject({
      invoiceNo: "20261031-043",
      status: "unpaid",
      remaining: 165_000,
      taxDisplay: "separate",
      issuer: { issuerName: "山田 太郎", registrationNumber: null },
      journalId: issued.journal.id,
      voidJournalId: null,
      voidedAt: null,
      payments: [],
    });
    expect(got.items.map((i) => [i.lineNo, i.taxCategory, i.taxRate])).toEqual([
      [1, "SALES_10", 10],
      [2, "SALES_8R", 8],
    ]);
    expect(got.taxBreakdown).toEqual([
      { rate: 10, inclusive: 110_000, tax: 10_000, exclusive: 100_000 },
      { rate: 8, inclusive: 55_000, tax: 4_074, exclusive: 50_926 },
    ]);

    const missing = await detail("00000000-0000-7000-8000-000000000000");
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).code).toBe("INVOICE_NOT_FOUND");
  });
});

describe("GET /journals/:journalId/origin（§6.1）", () => {
  it("請求書の仕訳は invoice の出所、ふつうの仕訳は null、ない仕訳は 404 JOURNAL_NOT_FOUND", async () => {
    const issued = await okBody(await issue());
    const res = await originOf(issued.journal.id);
    expect(res.status).toBe(200);
    expect(await okBody(res)).toEqual({
      origin: { kind: "invoice", invoiceId: issued.invoice.id, invoiceNo: "20261031-043" },
    });

    const manual = await ctx.e.journals.$post({
      param: ctx.param,
      json: {
        date: "2026-10-31",
        lines: [
          { side: "debit", accountId: ctx.accountId("売掛金"), amount: 100 },
          { side: "credit", accountId: ctx.accountId("売上高"), amount: 100 },
        ],
      },
    });
    const manualId = (await okBody(manual)).journal.id;
    expect(await okBody(await originOf(manualId))).toEqual({ origin: null });

    const missing = await originOf("00000000-0000-7000-8000-000000000000");
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).code).toBe("JOURNAL_NOT_FOUND");
  });

  it("請求書の仕訳は 001 の訂正・取消で触れず 409 JOURNAL_LINKED（invoiceId つき）", async () => {
    const issued = await okBody(await issue());
    const res = await ctx.e.journals[":journalId"].void.$post({
      param: { ...ctx.param, journalId: issued.journal.id },
      json: { reason: "取消", version: 1 },
    });
    expect(res.status).toBe(409);
    const error = await errorOf(res);
    expect(error.code).toBe("JOURNAL_LINKED");
    expect(error.details).toMatchObject({
      journalId: issued.journal.id,
      invoiceId: issued.invoice.id,
    });
  });
});
