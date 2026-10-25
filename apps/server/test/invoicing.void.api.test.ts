import { randomUUIDv7 } from "node:crypto";
import { openTenant } from "@trebuchet/db";
import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { errorOf } from "./helpers.ts";
import {
  createInvoicingTestContext,
  type InvoicingTestContext,
  okBody,
} from "./invoicing-helpers.ts";

// 005 US1: contracts/http-api.md §3.7（請求書の取消）

let tmp: TempDataDir;
let ctx: InvoicingTestContext;
let partnerId: string;

const setup = async (now?: string) => {
  ctx = await createInvoicingTestContext(now);
  await ctx.setSettings({ nextSeq: 43 });
  partnerId = await ctx.addPartner("株式会社A");
  await ctx.setTerms(partnerId, {
    billingType: "monthly",
    unitPrice: undefined,
    monthlyAmount: 110_000,
  });
};

beforeEach(async () => {
  tmp = useTempDataDir("server-invoicing-void");
  await setup();
});
afterEach(() => tmp.cleanup());

type InvoiceJson = Parameters<InvoicingTestContext["e"]["invoices"]["$post"]>[0]["json"];
const issue = async (over: Record<string, unknown> = {}) => {
  const res = await ctx.e.invoices.$post({
    param: ctx.param,
    json: {
      partnerId,
      targetMonth: "2026-10",
      confirmDuplicate: true,
      items: [{ name: "顧問料", amount: 110_000, taxCategory: "SALES_10" }],
      ...over,
    } as InvoiceJson,
  });
  if (res.status !== 201) throw new Error(`issue failed: ${res.status}`);
  return okBody(res);
};
const voidInvoice = (invoiceId: string, json: { reason: string }) =>
  ctx.e.invoices[":invoiceId"].void.$post({ param: { ...ctx.param, invoiceId }, json });
const journalOf = async (journalId: string) =>
  (await okBody(await ctx.e.journals[":journalId"].$get({ param: { ...ctx.param, journalId } })))
    .journal;

describe("POST /invoices/:invoiceId/void（§3.7）", () => {
  it("US1 Acceptance 7: 未締めの年度は 200。請求書は取消になり、元の仕訳が取り消される", async () => {
    const issued = await issue();
    const res = await voidInvoice(issued.invoice.id, { reason: "二重発行" });
    expect(res.status).toBe(200);
    const { invoice, journal } = await okBody(res);
    expect(invoice).toMatchObject({
      id: issued.invoice.id,
      status: "voided",
      remaining: 0,
      voidReason: "二重発行",
      voidJournalId: null,
    });
    expect(journal).toMatchObject({ id: issued.journal.id, status: "voided" });
    expect((await journalOf(issued.journal.id)).status).toBe("voided");

    // 詳細・一覧に voided で残る（消えない）
    const got = await okBody(
      await ctx.e.invoices[":invoiceId"].$get({
        param: { ...ctx.param, invoiceId: issued.invoice.id },
      }),
    );
    expect(got).toMatchObject({ status: "voided", voidReason: "二重発行" });
    const list = await okBody(await ctx.e.invoices.$get({ param: ctx.param, query: {} }));
    expect(list.invoices.map((i) => i.status)).toEqual(["voided"]);

    // 取り消した番号は再利用されない
    const again = await issue();
    expect(again.invoice.invoiceNo).toBe("20261031-044");
  });

  it("理由が空なら 422 REASON_REQUIRED、ない請求書は 404、取消済みは 409 INVOICE_VOIDED", async () => {
    const issued = await issue();
    const blank = await voidInvoice(issued.invoice.id, { reason: "  " });
    expect(blank.status).toBe(422);
    expect((await errorOf(blank)).code).toBe("REASON_REQUIRED");

    const missing = await voidInvoice("00000000-0000-7000-8000-000000000000", { reason: "x" });
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).code).toBe("INVOICE_NOT_FOUND");

    expect((await voidInvoice(issued.invoice.id, { reason: "x" })).status).toBe(200);
    const twice = await voidInvoice(issued.invoice.id, { reason: "y" });
    expect(twice.status).toBe(409);
    expect((await errorOf(twice)).code).toBe("INVOICE_VOIDED");
  });

  it("取消でない消し込みがあれば 409 INVOICE_HAS_PAYMENTS（details.paymentIds）。消し込みの取消の後は通る", async () => {
    const issued = await issue();
    // 消し込みを作る処理は US2。ここでは行を直接入れる（入金の仕訳はふつうの仕訳で代用）
    const paymentJournal = await ctx.e.journals.$post({
      param: ctx.param,
      json: {
        date: "2026-11-10",
        lines: [
          { side: "debit", accountId: ctx.accountId("普通預金"), amount: 110_000 },
          { side: "credit", accountId: ctx.accountId("売掛金"), amount: 110_000 },
        ],
      },
    });
    const paymentJournalId = (await okBody(paymentJournal)).journal.id;
    const paymentId = randomUUIDv7();
    const db = openTenant(ctx.entityId);
    db.$client
      .prepare(
        `INSERT INTO invoice_payments (id, invoice_id, received_on, amount, fee_amount, deposit_account_id, journal_id, created_at)
         VALUES (?, ?, '2026-11-10', 110000, 0, ?, ?, '2026-11-10T00:00:00.000Z')`,
      )
      .run(paymentId, issued.invoice.id, ctx.accountId("普通預金"), paymentJournalId);

    const blocked = await voidInvoice(issued.invoice.id, { reason: "x" });
    expect(blocked.status).toBe(409);
    const error = await errorOf(blocked);
    expect(error.code).toBe("INVOICE_HAS_PAYMENTS");
    expect(error.details).toMatchObject({ paymentIds: [paymentId] });
    expect((await journalOf(issued.journal.id)).status).toBe("active");

    db.$client
      .prepare("UPDATE invoice_payments SET voided_at = ?, void_reason = ? WHERE id = ?")
      .run("2026-11-11T00:00:00.000Z", "誤り", paymentId);
    expect((await voidInvoice(issued.invoice.id, { reason: "x" })).status).toBe(200);
  });
});

describe("POST /invoices/:invoiceId/void（締め済みの年度。US1 Acceptance 8）", () => {
  it("今日の年度に逆仕訳（訂正仕訳）を起票し、元の仕訳は変わらない", async () => {
    // 2027 年 3 月 10 日（UTC 03:00）に取り消す。2026 年度は締め、2027 年度を作る
    await setup("2027-03-10T03:00:00.000Z");
    expect((await ctx.e["fiscal-periods"].$post({ param: ctx.param })).status).toBe(201);
    const issued = await issue({ targetMonth: "2026-12", issueDate: "2026-12-20" });
    const original = await journalOf(issued.journal.id);
    const close = await ctx.e["fiscal-periods"][":year"].close.$post({
      param: { ...ctx.param, year: "2026" },
    });
    expect(close.status).toBe(200);

    const res = await voidInvoice(issued.invoice.id, { reason: "取り直し" });
    expect(res.status).toBe(200);
    const { invoice, journal } = await okBody(res);
    expect(journal).toMatchObject({
      date: "2027-03-10",
      correctsJournalId: original.id,
      status: "active",
    });
    expect(invoice).toMatchObject({ status: "voided", voidJournalId: journal.id });
    expect(journal.lines.map((l) => [l.side, l.amount])).toEqual([
      ["credit", 110_000],
      ["debit", 110_000],
    ]);
    expect(await journalOf(original.id)).toEqual(original);
  });

  it("今日の年度も締め済みなら 409 PERIOD_CLOSED で、何も変わらない", async () => {
    const issued = await issue();
    expect(
      (
        await ctx.e["fiscal-periods"][":year"].close.$post({
          param: { ...ctx.param, year: "2026" },
        })
      ).status,
    ).toBe(200);
    const res = await voidInvoice(issued.invoice.id, { reason: "x" });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe("PERIOD_CLOSED");
    const got = await okBody(
      await ctx.e.invoices[":invoiceId"].$get({
        param: { ...ctx.param, invoiceId: issued.invoice.id },
      }),
    );
    expect(got.status).toBe("unpaid");
  });
});
