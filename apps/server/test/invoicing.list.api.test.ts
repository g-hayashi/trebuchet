import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { errorOf } from "./helpers.ts";
import {
  createInvoicingTestContext,
  type InvoicingTestContext,
  okBody,
} from "./invoicing-helpers.ts";

// 005 US1: contracts/http-api.md §3.5（一覧の基本形。status・期限切れ・未回収の詳しい検査は invoicing.payments.api.test.ts）

let tmp: TempDataDir;
let ctx: InvoicingTestContext;
let a: string;
let b: string;

beforeEach(async () => {
  tmp = useTempDataDir("server-invoicing-list");
  ctx = await createInvoicingTestContext();
  await ctx.setSettings({ nextSeq: 1 });
  a = await ctx.addPartner("A 社");
  b = await ctx.addPartner("B 社");
  await ctx.setTerms(a, { billingType: "monthly", unitPrice: undefined, monthlyAmount: 100_000 });
  await ctx.setTerms(b, { billingType: "monthly", unitPrice: undefined, monthlyAmount: 200_000 });
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
const list = (query: { partnerId?: string; month?: string } = {}) =>
  ctx.e.invoices.$get({ param: ctx.param, query });

describe("GET /invoices（§3.5 の基本形）", () => {
  it("発行した請求書が unpaid・remaining = total で、発行日の降順に並ぶ。overdue は false、未回収の合計は空", async () => {
    const i1 = await issue(a, "2026-09", 100_000, "2026-09-30");
    const i2 = await issue(b, "2026-10", 200_000, "2026-10-31");
    const i3 = await issue(a, "2026-10", 100_000, "2026-10-31");

    const res = await list();
    expect(res.status).toBe(200);
    const body = await okBody(res);
    expect(body.invoices.map((i) => i.id)).toEqual([i3.id, i2.id, i1.id]);
    expect(body.invoices.map((i) => [i.status, i.paid, i.remaining, i.overdue, i.total])).toEqual([
      ["unpaid", 0, 100_000, false, 100_000],
      ["unpaid", 0, 200_000, false, 200_000],
      ["unpaid", 0, 100_000, false, 100_000],
    ]);
    expect(body.invoices[0]).toMatchObject({
      invoiceNo: "20261031-003",
      partnerId: a,
      recipientName: "A 社",
      targetMonth: "2026-10",
      issueDate: "2026-10-31",
      dueDate: "2026-11-30",
    });
    expect(body.outstandingByPartner.map((o) => [o.partnerName, o.outstanding, o.overdue])).toEqual(
      [
        ["A 社", 200_000, 0],
        ["B 社", 200_000, 0],
      ],
    );
  });

  it("partnerId・month で絞り込める", async () => {
    const i1 = await issue(a, "2026-09", 100_000, "2026-09-30");
    const i2 = await issue(b, "2026-10", 200_000, "2026-10-31");
    const i3 = await issue(a, "2026-10", 100_000, "2026-10-31");

    const byPartner = await okBody(await list({ partnerId: a }));
    expect(byPartner.invoices.map((i) => i.id)).toEqual([i3.id, i1.id]);
    const byMonth = await okBody(await list({ month: "2026-10" }));
    expect(byMonth.invoices.map((i) => i.id)).toEqual([i3.id, i2.id]);
    const both = await okBody(await list({ partnerId: b, month: "2026-10" }));
    expect(both.invoices.map((i) => i.id)).toEqual([i2.id]);
    expect((await okBody(await list({ month: "2025-01" }))).invoices).toEqual([]);
  });

  it("月の形が違えば 400 VALIDATION", async () => {
    const res = await list({ month: "2026-1" });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("VALIDATION");
  });
});
