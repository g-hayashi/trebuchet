import { randomUUIDv7 } from "node:crypto";
import { openTenant } from "@trebuchet/db";
import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { client, createTestEntity, errorOf } from "./helpers.ts";

// 005 US4: contracts/http-api.md §2.1〜§2.5

let tmp: TempDataDir;
let entityId: string;

const e = client.api.entities[":entityId"];
const param = () => ({ entityId });

beforeEach(async () => {
  tmp = useTempDataDir("server-invoicing-settings");
  entityId = await createTestEntity();
});
afterEach(() => tmp.cleanup());

/** エラーの応答（{ error }）を除いた成功のボディの型にする */
const okBody = async <R extends { json(): Promise<unknown> }>(
  res: R,
): Promise<Exclude<Awaited<ReturnType<R["json"]>>, { error: unknown }>> =>
  (await res.json()) as Exclude<Awaited<ReturnType<R["json"]>>, { error: unknown }>;

const settingsBody = (over: Record<string, unknown> = {}) => ({
  issuerName: "山田 太郎",
  address: "東京都千代田区",
  contact: "taro@example.com",
  bankAccount: "○○銀行\n普通 1234567",
  taxDisplay: "separate" as const,
  nextSeq: 1,
  ...over,
});

type SettingsJson = Parameters<(typeof e)["invoice-settings"]["$put"]>[0]["json"];
const putSettings = (over: Record<string, unknown> = {}) =>
  e["invoice-settings"].$put({ param: param(), json: settingsBody(over) as SettingsJson });

const addPartner = async (name: string, honorific: "様" | "御中" | null = "御中") => {
  const res = await e.partners.$post({ param: param(), json: { name, honorific } });
  if (res.status !== 201) throw new Error(`partner create failed: ${res.status}`);
  return (await res.json()).partner.id;
};

const terms = e.partners[":partnerId"]["billing-terms"];
type TermsJson = Parameters<typeof terms.$put>[0]["json"];
const hourly = (over: Record<string, unknown> = {}) =>
  ({
    billingType: "hourly",
    unitPrice: 10_000,
    dueMonthsAfter: 1,
    dueDay: 31,
    defaultItemName: "システム開発",
    ...over,
  }) as TermsJson;
const putTerms = (partnerId: string, json: TermsJson) =>
  terms.$put({ param: { ...param(), partnerId }, json });

/** 発行済みの請求書の行を直接入れる（発行の API は US1 で足す） */
async function seedInvoice(seq: number): Promise<void> {
  const partnerId = await addPartner(`発行先${seq}`);
  const accounts = await e.accounts.$get({ param: param() });
  if (accounts.status !== 200) throw new Error(String(accounts.status));
  const byName = new Map((await accounts.json()).accounts.map((a) => [a.name, a.id]));
  const res = await e.journals.$post({
    param: param(),
    json: {
      date: "2026-10-31",
      lines: [
        { side: "debit", accountId: byName.get("売掛金") ?? "", amount: 110_000 },
        { side: "credit", accountId: byName.get("売上高") ?? "", amount: 110_000 },
      ],
    },
  });
  if (res.status !== 201) throw new Error(`journal create failed: ${res.status}`);
  const journalId = (await res.json()).journal.id;
  openTenant(entityId)
    .$client.prepare(
      `INSERT INTO invoices (id, invoice_no, seq, partner_id, target_month, issue_date, sales_date, due_date,
         recipient_name, recipient_honorific, issuer_json, tax_display, total, journal_id, created_at)
       VALUES (?, ?, ?, ?, '2026-10', '2026-10-31', '2026-10-31', '2026-11-30',
         '株式会社A', '御中', '{}', 'inclusive_only', 110000, ?, '2026-10-31T00:00:00.000Z')`,
    )
    .run(randomUUIDv7(), `20261031-${String(seq).padStart(3, "0")}`, seq, partnerId, journalId);
}

describe("GET・PUT /invoice-settings（§2.1・§2.2。FR-003, FR-004）", () => {
  it("設定がなければ 200 { settings: null, minimumNextSeq: 1 }", async () => {
    const res = await e["invoice-settings"].$get({ param: param() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ settings: null, minimumNextSeq: 1 });
  });

  it("PUT して GET で読み戻せる（往復）", async () => {
    const put = await putSettings({ nextSeq: 43, tradeName: "山田設計" });
    expect(put.status).toBe(200);
    if (put.status !== 200) return;
    const { settings } = await put.json();
    expect(settings).toMatchObject({
      issuerName: "山田 太郎",
      tradeName: "山田設計",
      registrationNumber: null,
      taxDisplay: "separate",
      nextSeq: 43,
    });
    const res = await e["invoice-settings"].$get({ param: param() });
    expect(await res.json()).toEqual({ settings, minimumNextSeq: 1 });
  });

  it("発行済みの最大の seq 以下の nextSeq は 422 INVOICE_SEQ_TOO_LOW（details.minimum）", async () => {
    await seedInvoice(5);
    const get = await e["invoice-settings"].$get({ param: param() });
    expect((await okBody(get)).minimumNextSeq).toBe(6);

    const res = await putSettings({ nextSeq: 5 });
    expect(res.status).toBe(422);
    const error = await errorOf(res);
    expect(error.code).toBe("INVOICE_SEQ_TOO_LOW");
    expect(error.details).toMatchObject({ minimum: 6 });

    expect((await putSettings({ nextSeq: 6 })).status).toBe(200);
  });

  it("400 VALIDATION: 登録番号の形・nextSeq が 0・税の表示が不正", async () => {
    for (const over of [{ registrationNumber: "T123" }, { nextSeq: 0 }, { taxDisplay: "other" }]) {
      const res = await putSettings(over);
      expect(res.status).toBe(400);
      expect((await errorOf(res)).code).toBe("VALIDATION");
    }
  });
});

describe("PUT /partners/:partnerId/billing-terms（§2.4。FR-001, FR-002）", () => {
  it("時間単価型を保存して 200 { terms }", async () => {
    const partnerId = await addPartner("株式会社A");
    const res = await putTerms(partnerId, hourly());
    expect(res.status).toBe(200);
    if (res.status !== 200) return;
    expect((await res.json()).terms).toMatchObject({
      partnerId,
      billingType: "hourly",
      unitPrice: 10_000,
      monthlyAmount: null,
      dueMonthsAfter: 1,
      dueDay: 31,
      defaultItemName: "システム開発",
      billingName: null,
    });
  });

  it("月額定額型は monthlyAmount と宛名を保存する", async () => {
    const partnerId = await addPartner("株式会社A");
    const res = await putTerms(partnerId, {
      billingType: "monthly",
      monthlyAmount: 300_000,
      dueMonthsAfter: 0,
      dueDay: 25,
      defaultItemName: "顧問料",
      billingName: "A 社 経理部",
    });
    expect(res.status).toBe(200);
    if (res.status !== 200) return;
    expect((await res.json()).terms).toMatchObject({
      billingType: "monthly",
      unitPrice: null,
      monthlyAmount: 300_000,
      billingName: "A 社 経理部",
    });
  });

  it("400 VALIDATION: 型に合わない金額（時間単価型に月額、月額型に単価、単価なし、0・小数の単価）", async () => {
    const partnerId = await addPartner("株式会社A");
    const bad: Record<string, unknown>[] = [
      { monthlyAmount: 100_000 },
      { unitPrice: undefined },
      { unitPrice: 0 },
      { unitPrice: 1000.5 },
      { billingType: "monthly", unitPrice: 10_000, monthlyAmount: 100_000 },
      { billingType: "monthly", unitPrice: undefined, monthlyAmount: undefined },
    ];
    for (const over of bad) {
      const res = await putTerms(partnerId, hourly(over));
      expect(res.status, JSON.stringify(over)).toBe(400);
      expect((await errorOf(res)).code).toBe("VALIDATION");
    }
  });

  it("400 VALIDATION: dueDay の 29・30 と 0、dueMonthsAfter の 13", async () => {
    const partnerId = await addPartner("株式会社A");
    for (const over of [{ dueDay: 29 }, { dueDay: 30 }, { dueDay: 0 }, { dueMonthsAfter: 13 }]) {
      const res = await putTerms(partnerId, hourly(over));
      expect(res.status).toBe(400);
    }
    expect((await putTerms(partnerId, hourly({ dueDay: 28 }))).status).toBe(200);
    expect((await putTerms(partnerId, hourly({ dueDay: 31 }))).status).toBe(200);
  });

  it("400 VALIDATION（details.field = partnerId）: 存在しない取引先", async () => {
    const res = await putTerms(randomUUIDv7(), hourly());
    expect(res.status).toBe(400);
    const error = await errorOf(res);
    expect(error.code).toBe("VALIDATION");
    expect(error.details).toMatchObject({ field: "partnerId" });
  });
});

describe("GET /billing-terms（§2.3）", () => {
  it("条件がなければ空", async () => {
    const res = await e["billing-terms"].$get({ param: param() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ terms: [] });
  });

  it("partnerName・honorific・partnerActive を付けて返す", async () => {
    const a = await addPartner("A 商事", "様");
    const b = await addPartner("B 工業", null);
    await putTerms(a, hourly());
    await putTerms(b, hourly({ unitPrice: 8_000 }));
    // B を使用停止にする（取引先の使用停止の API はまだないので、行を直接直す）
    openTenant(entityId).$client.prepare("UPDATE partners SET is_active = 0 WHERE id = ?").run(b);

    const res = await e["billing-terms"].$get({ param: param() });
    const body = await okBody(res);
    expect(body.terms).toHaveLength(2);
    expect(body.terms[0]).toMatchObject({
      partnerId: a,
      partnerName: "A 商事",
      honorific: "様",
      partnerActive: true,
      unitPrice: 10_000,
    });
    expect(body.terms[1]).toMatchObject({
      partnerId: b,
      partnerName: "B 工業",
      honorific: null,
      partnerActive: false,
    });
  });
});

describe("DELETE /partners/:partnerId/billing-terms（§2.5）", () => {
  it("204 で条件を外す。もう一度でも 204（取引先は残る）", async () => {
    const partnerId = await addPartner("株式会社A");
    await putTerms(partnerId, hourly());
    const res = await terms.$delete({ param: { ...param(), partnerId } });
    expect(res.status).toBe(204);
    const list = await e["billing-terms"].$get({ param: param() });
    expect((await okBody(list)).terms).toEqual([]);
    expect((await terms.$delete({ param: { ...param(), partnerId } })).status).toBe(204);
    const partners = await e.partners.$get({ param: param() });
    expect((await partners.json()).partners.map((p) => p.id)).toContain(partnerId);
  });
});
