import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { errorOf } from "./helpers.ts";
import {
  createInvoicingTestContext,
  type InvoicingTestContext,
  okBody,
  TODAY,
} from "./invoicing-helpers.ts";

// 005 US1: contracts/http-api.md §3.1〜§3.3（工数と請求書の案）

let tmp: TempDataDir;
let ctx: InvoicingTestContext;

beforeEach(async () => {
  tmp = useTempDataDir("server-invoicing-drafts");
  ctx = await createInvoicingTestContext();
});
afterEach(() => tmp.cleanup());

const putHours = (month: string, entries: { partnerId: string; hours: number }[]) =>
  ctx.e["work-hours"][":month"].$put({
    param: { ...ctx.param, month },
    json: { entries },
  });
const getHours = (month: string) =>
  ctx.e["work-hours"].$get({ param: ctx.param, query: { month } });
const postDrafts = (json: { month: string; partnerIds?: string[] }) =>
  ctx.e.invoices.drafts.$post({ param: ctx.param, json });

describe("GET・PUT /work-hours（§3.1・§3.2。FR-005）", () => {
  it("時間単価型の有効な取引先だけが並び、未入力は hours: null。PUT で往復できる", async () => {
    const a = await ctx.addPartner("A 社");
    const m = await ctx.addPartner("月額社");
    await ctx.setTerms(a);
    await ctx.setTerms(m, { billingType: "monthly", unitPrice: undefined, monthlyAmount: 300_000 });

    const before = await getHours("2026-10");
    expect(before.status).toBe(200);
    expect(await okBody(before)).toEqual({ entries: [{ partnerId: a, hours: null }] });

    const put = await putHours("2026-10", [{ partnerId: a, hours: 120.5 }]);
    expect(put.status).toBe(200);
    expect(await okBody(put)).toEqual({ entries: [{ partnerId: a, hours: 120.5 }] });
    expect(await okBody(await getHours("2026-10"))).toEqual({
      entries: [{ partnerId: a, hours: 120.5 }],
    });
    expect(await okBody(await getHours("2026-09"))).toEqual({
      entries: [{ partnerId: a, hours: null }],
    });
  });

  it("0.5 の倍数でない工数（1.25）は 400 VALIDATION で、何も保存しない", async () => {
    const a = await ctx.addPartner("A 社");
    await ctx.setTerms(a);
    const res = await putHours("2026-10", [{ partnerId: a, hours: 1.25 }]);
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("VALIDATION");
    expect(await okBody(await getHours("2026-10"))).toEqual({
      entries: [{ partnerId: a, hours: null }],
    });
  });

  it("時間単価型でない取引先の工数は 400 VALIDATION（details.field = partnerId）、月の形が違えば 400", async () => {
    const m = await ctx.addPartner("月額社");
    await ctx.setTerms(m, { billingType: "monthly", unitPrice: undefined, monthlyAmount: 1 });
    const res = await putHours("2026-10", [{ partnerId: m, hours: 1 }]);
    expect(res.status).toBe(400);
    const error = await errorOf(res);
    expect(error.code).toBe("VALIDATION");
    expect(error.details).toMatchObject({ field: "partnerId" });

    expect((await putHours("2026-13", [])).status).toBe(400);
    expect((await getHours("2026-1")).status).toBe(400);
  });
});

describe("POST /invoices/drafts（§3.3。FR-006・FR-016）", () => {
  it("US1 Acceptance 1: 120.5 時間 × 10,000 円。発行日は偽の時計の今日、支払期限は翌月末", async () => {
    await ctx.setSettings();
    const a = await ctx.addPartner("A 社");
    await ctx.setTerms(a);
    await putHours("2026-10", [{ partnerId: a, hours: 120.5 }]);

    const res = await postDrafts({ month: "2026-10" });
    expect(res.status).toBe(200);
    const { drafts, skipped } = await okBody(res);
    expect(skipped).toEqual([]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      partnerId: a,
      targetMonth: "2026-10",
      issueDate: TODAY,
      salesDate: "2026-10-31",
      dueDate: "2026-11-30",
      total: 1_205_000,
      taxDisplay: "inclusive_only",
      taxBreakdown: [],
      warnings: [],
    });
    expect(drafts[0]?.items).toEqual([
      {
        name: "10月分 業務委託",
        quantity: 120.5,
        unit: "時間",
        unitPrice: 10_000,
        amount: 1_205_000,
        taxCategory: "OUT_OF_SCOPE",
      },
    ]);
  });

  it("US1 Acceptance 2: 月額定額型は工数なしで案ができる。工数なし・0 時間の時間単価型は skipped", async () => {
    const a = await ctx.addPartner("A 社");
    const b = await ctx.addPartner("B 社");
    const c = await ctx.addPartner("C 社");
    await ctx.setTerms(a, { billingType: "monthly", unitPrice: undefined, monthlyAmount: 300_000 });
    await ctx.setTerms(b);
    await ctx.setTerms(c);
    await putHours("2026-10", [{ partnerId: c, hours: 0 }]);

    const { drafts, skipped } = await okBody(await postDrafts({ month: "2026-10" }));
    expect(drafts.map((d) => [d.partnerId, d.total])).toEqual([[a, 300_000]]);
    expect(skipped).toEqual([
      { partnerId: b, reason: "NO_HOURS" },
      { partnerId: c, reason: "ZERO_HOURS" },
    ]);
  });

  it("課税事業者で別記なら、税率ごとの内訳つきの案（税区分は売上 10%）", async () => {
    await ctx.makeTaxable();
    await ctx.setSettings({ taxDisplay: "separate" });
    const a = await ctx.addPartner("A 社");
    await ctx.setTerms(a, { billingType: "monthly", unitPrice: undefined, monthlyAmount: 110_000 });
    const { drafts } = await okBody(await postDrafts({ month: "2026-10" }));
    expect(drafts[0]).toMatchObject({
      taxDisplay: "separate",
      taxBreakdown: [{ rate: 10, inclusive: 110_000, tax: 10_000, exclusive: 100_000 }],
    });
    expect(drafts[0]?.items[0]?.taxCategory).toBe("SALES_10");
  });

  it("partnerIds で絞り込み、条件のない取引先は 422 BILLING_TERMS_MISSING、月の形が違えば 400", async () => {
    const a = await ctx.addPartner("A 社");
    const bare = await ctx.addPartner("条件なし");
    await ctx.setTerms(a, { billingType: "monthly", unitPrice: undefined, monthlyAmount: 1_000 });
    const only = await okBody(await postDrafts({ month: "2026-10", partnerIds: [a] }));
    expect(only.drafts.map((d) => d.partnerId)).toEqual([a]);

    const res = await postDrafts({ month: "2026-10", partnerIds: [bare] });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe("BILLING_TERMS_MISSING");

    expect((await postDrafts({ month: "2026-1" })).status).toBe(400);
  });
});
