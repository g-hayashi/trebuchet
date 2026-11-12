import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createInvoicingTestContext,
  type InvoicingTestContext,
  okBody,
} from "./invoicing-helpers.ts";

// 013 US3: contracts/http-api.md §4（GET /withholding/:year）

let tmp: TempDataDir;
let ctx: InvoicingTestContext;
let a: string;
let b: string;

beforeEach(async () => {
  tmp = useTempDataDir("server-invoicing-withholding");
  ctx = await createInvoicingTestContext();
  // 2027 年の入金日のために 2027 年度を作る（年またぎ）
  expect((await ctx.e["fiscal-periods"].$post({ param: ctx.param })).status).toBe(201);
  await ctx.setSettings({ nextSeq: 1, taxDisplay: "inclusive_only" });
  b = await ctx.addPartner("B 社");
  a = await ctx.addPartner("A 社");
  for (const [id, amount] of [
    [a, 110_000],
    [b, 220_000],
  ] as const) {
    await ctx.setTerms(id, {
      billingType: "monthly",
      unitPrice: undefined,
      monthlyAmount: amount,
      withholding: true,
    });
  }
});
afterEach(() => tmp.cleanup());

type InvoiceJson = Parameters<InvoicingTestContext["e"]["invoices"]["$post"]>[0]["json"];
const issue = async (partnerId: string, targetMonth: string, amount: number) => {
  const res = await ctx.e.invoices.$post({
    param: ctx.param,
    json: {
      partnerId,
      targetMonth,
      issueDate: "2026-10-31",
      confirmDuplicate: true,
      items: [{ name: "顧問料", amount }],
    } as InvoiceJson,
  });
  if (res.status !== 201) throw new Error(`issue failed: ${res.status}`);
  return (await okBody(res)).invoice;
};
type PaymentJson = Parameters<
  InvoicingTestContext["e"]["invoices"][":invoiceId"]["payments"]["$post"]
>[0]["json"];
const pay = async (invoiceId: string, receivedOn: string, amount: number, withholding: number) => {
  const res = await ctx.e.invoices[":invoiceId"].payments.$post({
    param: { ...ctx.param, invoiceId },
    json: {
      receivedOn,
      amount,
      withholdingAmount: withholding,
      depositAccountId: ctx.accountId("普通預金"),
    } as PaymentJson,
  });
  if (res.status !== 201) throw new Error(`pay failed: ${res.status}`);
  return (await okBody(res)).payment;
};
const summary = (year: string) =>
  ctx.e.withholding[":year"].$get({ param: { ...ctx.param, year } });

describe("GET /withholding/:year（§4）", () => {
  it("200: その暦年の取消でない源泉徴収つきの消し込みを、取引先名の順に集計する", async () => {
    const ia = await issue(a, "2026-08", 110_000);
    const ib = await issue(b, "2026-09", 220_000);
    const ib2 = await issue(b, "2026-10", 220_000);
    const ia2 = await issue(a, "2026-07", 110_000);
    const pa = await pay(ia.id, "2026-11-10", 100_000, 10_000);
    await pay(ib.id, "2026-12-20", 200_000, 20_000);
    await pay(ib2.id, "2027-01-10", 200_000, 20_000);
    // 源泉徴収 0 の入金は含めない
    await pay(ia2.id, "2026-11-11", 110_000, 0);

    const res = await summary("2026");
    expect(res.status).toBe(200);
    const body = await okBody(res);
    expect(body).toMatchObject({ year: 2026, appliedTotal: 330_000, withholdingTotal: 30_000 });
    expect(body.partners.map((p) => p.partnerName)).toEqual(["A 社", "B 社"]);
    expect(body.partners[0]).toMatchObject({
      partnerId: a,
      paymentCount: 1,
      appliedTotal: 110_000,
      withholdingTotal: 10_000,
      payments: [
        {
          paymentId: pa.id,
          invoiceId: ia.id,
          invoiceNo: ia.invoiceNo,
          receivedOn: "2026-11-10",
          applied: 110_000,
          withholdingAmount: 10_000,
        },
      ],
    });
    const next = await okBody(await summary("2027"));
    expect(next).toMatchObject({ year: 2027, withholdingTotal: 20_000 });
  });

  it("取り消した消し込みは集計から外れる", async () => {
    const ia = await issue(a, "2026-08", 110_000);
    const p = await pay(ia.id, "2026-11-10", 100_000, 10_000);
    expect((await okBody(await summary("2026"))).withholdingTotal).toBe(10_000);
    const voided = await ctx.e.invoices[":invoiceId"].payments[":paymentId"].void.$post({
      param: { ...ctx.param, invoiceId: ia.id, paymentId: p.id },
      json: { reason: "誤り" },
    });
    expect(voided.status).toBe(200);
    expect(await okBody(await summary("2026"))).toEqual({
      year: 2026,
      partners: [],
      appliedTotal: 0,
      withholdingTotal: 0,
    });
  });

  it("入金のない年・会計期間のない年は 200 で空", async () => {
    for (const year of ["2026", "1999"]) {
      const res = await summary(year);
      expect(res.status).toBe(200);
      expect(await okBody(res)).toEqual({
        year: Number(year),
        partners: [],
        appliedTotal: 0,
        withholdingTotal: 0,
      });
    }
  });
});
