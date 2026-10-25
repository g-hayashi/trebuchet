import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { errorOf } from "./helpers.ts";
import {
  createInvoicingTestContext,
  type InvoicingTestContext,
  okBody,
} from "./invoicing-helpers.ts";

// 005 US2: contracts/http-api.md §3.5（期限切れ・status・未回収）、§4.1（消し込み）、§4.2（取消）

let tmp: TempDataDir;
let ctx: InvoicingTestContext;
let a: string;
let b: string;

const setup = async (now?: string) => {
  ctx = await createInvoicingTestContext(now);
  await ctx.setSettings({ nextSeq: 1 });
  a = await ctx.addPartner("A 社");
  b = await ctx.addPartner("B 社");
  await ctx.setTerms(a, { billingType: "monthly", unitPrice: undefined, monthlyAmount: 100_000 });
  await ctx.setTerms(b, { billingType: "monthly", unitPrice: undefined, monthlyAmount: 200_000 });
};

beforeEach(async () => {
  tmp = useTempDataDir("server-invoicing-payments");
  await setup();
});
afterEach(() => tmp.cleanup());

type InvoiceJson = Parameters<InvoicingTestContext["e"]["invoices"]["$post"]>[0]["json"];
const issue = async (partnerId: string, targetMonth: string, amount: number, issueDate: string) => {
  const res = await ctx.e.invoices.$post({
    param: ctx.param,
    json: { partnerId, targetMonth, issueDate, items: [{ name: "顧問料", amount }] } as InvoiceJson,
  });
  if (res.status !== 201) throw new Error(`issue failed: ${res.status}`);
  return (await okBody(res)).invoice;
};
type PaymentJson = Parameters<
  InvoicingTestContext["e"]["invoices"][":invoiceId"]["payments"]["$post"]
>[0]["json"];
const pay = (invoiceId: string, json: Partial<PaymentJson> & { amount: number }) =>
  ctx.e.invoices[":invoiceId"].payments.$post({
    param: { ...ctx.param, invoiceId },
    json: {
      receivedOn: "2026-11-10",
      depositAccountId: ctx.accountId("普通預金"),
      ...json,
    } as PaymentJson,
  });
const voidPayment = (invoiceId: string, paymentId: string, reason: string) =>
  ctx.e.invoices[":invoiceId"].payments[":paymentId"].void.$post({
    param: { ...ctx.param, invoiceId, paymentId },
    json: { reason },
  });
const list = (query: { partnerId?: string; month?: string; status?: string } = {}) =>
  ctx.e.invoices.$get({ param: ctx.param, query: query as never });
const detail = async (invoiceId: string) =>
  okBody(await ctx.e.invoices[":invoiceId"].$get({ param: { ...ctx.param, invoiceId } }));

describe("POST /invoices/:invoiceId/payments（§4.1）", () => {
  it("全額の消し込みは 201。借方 入金先・貸方 売掛金（取引先つき）の仕訳で、請求書は paid・残額 0", async () => {
    const inv = await issue(a, "2026-10", 100_000, "2026-10-31");
    const res = await pay(inv.id, { amount: 100_000 });
    expect(res.status).toBe(201);
    const body = await okBody(res);
    expect(body.payment).toMatchObject({
      receivedOn: "2026-11-10",
      amount: 100_000,
      feeAmount: 0,
      depositAccountId: ctx.accountId("普通預金"),
      voidedAt: null,
    });
    expect(body.invoice).toMatchObject({ status: "paid", paid: 100_000, remaining: 0 });
    expect(body.journal).toMatchObject({ date: "2026-11-10", status: "active" });
    expect(body.journal.lines.map((l) => [l.side, l.accountId, l.amount, l.partnerId])).toEqual([
      ["debit", ctx.accountId("普通預金"), 100_000, a],
      ["credit", ctx.accountId("売掛金"), 100_000, a],
    ]);
    expect(body.payment.journalId).toBe(body.journal.id);

    const got = await detail(inv.id);
    expect(got.payments.map((p) => p.id)).toEqual([body.payment.id]);
  });

  it("treatDifferenceAsFee: 差額は支払手数料（借方）。売掛金には充当額（入金額 + 手数料）", async () => {
    const inv = await issue(a, "2026-10", 100_000, "2026-10-31");
    const res = await pay(inv.id, { amount: 99_560, treatDifferenceAsFee: true });
    expect(res.status).toBe(201);
    const body = await okBody(res);
    expect(body.payment).toMatchObject({ amount: 99_560, feeAmount: 440 });
    expect(body.invoice).toMatchObject({ status: "paid", remaining: 0 });
    expect(body.journal.lines.map((l) => [l.side, l.amount])).toEqual([
      ["debit", 99_560],
      ["debit", 440],
      ["credit", 100_000],
    ]);
  });

  it("一部の入金は partial。残額 ≦ 入金額で treatDifferenceAsFee なら 400 か 422 の VALIDATION", async () => {
    const inv = await issue(a, "2026-10", 100_000, "2026-10-31");
    const part = await okBody(await pay(inv.id, { amount: 30_000 }));
    expect(part.invoice).toMatchObject({ status: "partial", paid: 30_000, remaining: 70_000 });

    const bad = await pay(inv.id, { amount: 70_000, treatDifferenceAsFee: true });
    expect([400, 422]).toContain(bad.status);
    expect((await errorOf(bad)).code).toBe("VALIDATION");
  });

  it("残額を超える入金は 422 PAYMENT_EXCEEDS_BALANCE で、何も残らない", async () => {
    const inv = await issue(a, "2026-10", 100_000, "2026-10-31");
    const res = await pay(inv.id, { amount: 100_001 });
    expect(res.status).toBe(422);
    const error = await errorOf(res);
    expect(error.code).toBe("PAYMENT_EXCEEDS_BALANCE");
    expect(error.details).toMatchObject({ remaining: 100_000 });
    expect((await detail(inv.id)).payments).toEqual([]);
  });

  it("締め済みの入金日は 409 PERIOD_CLOSED で何も残らない。ない請求書は 404 INVOICE_NOT_FOUND", async () => {
    const inv = await issue(a, "2026-10", 100_000, "2026-10-31");
    const closed = await ctx.e["fiscal-periods"][":year"].close.$post({
      param: { ...ctx.param, year: "2026" },
    });
    expect(closed.status).toBe(200);
    const res = await pay(inv.id, { amount: 100_000 });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe("PERIOD_CLOSED");
    expect((await detail(inv.id)).payments).toEqual([]);

    const missing = await pay("00000000-0000-7000-8000-000000000000", { amount: 1 });
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).code).toBe("INVOICE_NOT_FOUND");
  });

  it("取消済みの請求書への入金は 409 INVOICE_VOIDED", async () => {
    const inv = await issue(a, "2026-10", 100_000, "2026-10-31");
    const v = await ctx.e.invoices[":invoiceId"].void.$post({
      param: { ...ctx.param, invoiceId: inv.id },
      json: { reason: "誤り" },
    });
    expect(v.status).toBe(200);
    const res = await pay(inv.id, { amount: 100_000 });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe("INVOICE_VOIDED");
  });
});

describe("POST /invoices/:invoiceId/payments/:paymentId/void（§4.2）", () => {
  it("取消で残額が戻り、入金の仕訳が取り消される。2 回目は 409 PAYMENT_VOIDED", async () => {
    const inv = await issue(a, "2026-10", 100_000, "2026-10-31");
    const paid = await okBody(await pay(inv.id, { amount: 99_560, treatDifferenceAsFee: true }));
    expect((await detail(inv.id)).status).toBe("paid");

    const res = await voidPayment(inv.id, paid.payment.id, "入金の誤り");
    expect(res.status).toBe(200);
    const body = await okBody(res);
    expect(body.payment).toMatchObject({ id: paid.payment.id, voidReason: "入金の誤り" });
    expect(body.payment.voidedAt).not.toBeNull();
    expect(body.invoice).toMatchObject({ status: "unpaid", paid: 0, remaining: 100_000 });
    expect(body.journal).toMatchObject({ id: paid.journal.id, status: "voided" });

    expect((await detail(inv.id)).remaining).toBe(100_000);
    // 取消の後は、同じ請求書に改めて消し込める
    expect((await pay(inv.id, { amount: 100_000 })).status).toBe(201);

    const twice = await voidPayment(inv.id, paid.payment.id, "again");
    expect(twice.status).toBe(409);
    expect((await errorOf(twice)).code).toBe("PAYMENT_VOIDED");
  });

  it("理由が空なら 422 REASON_REQUIRED、ない消し込みは 404 PAYMENT_NOT_FOUND", async () => {
    const inv = await issue(a, "2026-10", 100_000, "2026-10-31");
    const paid = await okBody(await pay(inv.id, { amount: 100_000 }));
    const blank = await voidPayment(inv.id, paid.payment.id, " ");
    expect(blank.status).toBe(422);
    expect((await errorOf(blank)).code).toBe("REASON_REQUIRED");

    const missing = await voidPayment(inv.id, "00000000-0000-7000-8000-000000000000", "x");
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).code).toBe("PAYMENT_NOT_FOUND");
  });
});

describe("GET /invoices の期限切れ・status・未回収（§3.5）", () => {
  // 今日は 2026-10-31（偽の時計）。支払期限は発行日の翌月末
  const seed = async () => {
    // 期限 2026-09-30（期限切れ）
    const late = await issue(a, "2026-08", 100_000, "2026-08-31");
    // 期限 2026-10-31（当日。期限切れではない）
    const edge = await issue(b, "2026-09", 200_000, "2026-09-30");
    // 期限 2026-11-30（まだ）
    const future = await issue(a, "2026-10", 50_000, "2026-10-31");
    return { late, edge, future };
  };

  it("期限が今日より前で残額があるものだけ overdue。当日は偽", async () => {
    const { late, edge, future } = await seed();
    const body = await okBody(await list());
    const byId = new Map(body.invoices.map((i) => [i.id, i]));
    expect(byId.get(late.id)).toMatchObject({
      dueDate: "2026-09-30",
      status: "unpaid",
      overdue: true,
    });
    expect(byId.get(edge.id)).toMatchObject({ dueDate: "2026-10-31", overdue: false });
    expect(byId.get(future.id)).toMatchObject({ overdue: false });

    // 詳細にも反映する
    expect((await detail(late.id)).overdue).toBe(true);
    expect((await detail(edge.id)).overdue).toBe(false);
  });

  it("status の絞り込み（unpaid・partial・paid・voided・overdue）", async () => {
    const { late, edge, future } = await seed();
    await pay(edge.id, { amount: 200_000, receivedOn: "2026-10-31" });
    await pay(future.id, { amount: 10_000, receivedOn: "2026-10-31" });
    const ids = async (status: string) =>
      (await okBody(await list({ status }))).invoices.map((i) => i.id);
    expect(await ids("paid")).toEqual([edge.id]);
    expect(await ids("partial")).toEqual([future.id]);
    expect(await ids("unpaid")).toEqual([late.id]);
    expect(await ids("overdue")).toEqual([late.id]);
    expect(await ids("voided")).toEqual([]);

    // 入金すると期限切れでなくなる
    await pay(late.id, { amount: 100_000, receivedOn: "2026-10-31" });
    expect(await ids("overdue")).toEqual([]);

    const bad = await list({ status: "unknown" });
    expect(bad.status).toBe(400);
    expect((await errorOf(bad)).code).toBe("VALIDATION");
  });

  it("outstandingByPartner: 取消・全額入金の請求書を除いた残額の合計と、うち期限切れ", async () => {
    const { late, edge } = await seed();
    await pay(edge.id, { amount: 200_000, receivedOn: "2026-10-31" });
    await pay(late.id, { amount: 30_000, receivedOn: "2026-10-31" });
    const voided = await issue(b, "2026-10", 999, "2026-10-31");
    await ctx.e.invoices[":invoiceId"].void.$post({
      param: { ...ctx.param, invoiceId: voided.id },
      json: { reason: "誤り" },
    });

    const body = await okBody(await list());
    expect(body.outstandingByPartner).toEqual([
      // A: 70,000（期限切れ）+ 50,000。B は未回収なし
      { partnerId: a, partnerName: "A 社", outstanding: 120_000, overdue: 70_000 },
    ]);

    // 全額入金して取り消すと、未回収に戻る
    const detailBefore = await detail(edge.id);
    await voidPayment(edge.id, detailBefore.payments[0]?.id ?? "", "誤り");
    const after = await okBody(await list());
    expect(after.outstandingByPartner).toEqual([
      { partnerId: a, partnerName: "A 社", outstanding: 120_000, overdue: 70_000 },
      { partnerId: b, partnerName: "B 社", outstanding: 200_000, overdue: 0 },
    ]);
  });
});
