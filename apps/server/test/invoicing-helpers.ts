import { testClient } from "hono/testing";
import { createApp } from "../src/app.ts";
import { createTestEntity, createTestSession, TEST_HOST, TEST_ORIGIN } from "./helpers.ts";

/**
 * 請求書（005）の server のテストの共通部品。偽の時計（`now`）で `createApp({ clock })` を作り、
 * その時刻のセッションで呼ぶ。時刻は UTC と JST の 0 時から離す（CI の `TZ` に依存させない）
 */

/** UTC 03:00 = JST 12:00（同じ暦日）。今日は 2026-10-31 */
export const NOW = "2026-10-31T03:00:00.000Z";
export const TODAY = "2026-10-31";

export async function createInvoicingTestContext(now = NOW) {
  const entityId = await createTestEntity();
  const session = await createTestSession({ now });
  const client = testClient(createApp({ clock: { now: () => now } }), undefined, undefined, {
    headers: { Host: TEST_HOST, Origin: TEST_ORIGIN, Cookie: session.cookie },
  });
  const e = client.api.entities[":entityId"];
  const param = { entityId };

  const accounts = await e.accounts.$get({ param });
  if (accounts.status !== 200) throw new Error(`accounts failed: ${accounts.status}`);
  const accountIds = new Map((await accounts.json()).accounts.map((a) => [a.name, a.id]));
  const accountId = (name: string) => {
    const id = accountIds.get(name);
    if (id === undefined) throw new Error(`科目がない: ${name}`);
    return id;
  };

  const addPartner = async (name: string, honorific: "様" | "御中" | null = "御中") => {
    const res = await e.partners.$post({ param, json: { name, honorific } });
    if (res.status !== 201) throw new Error(`partner create failed: ${res.status}`);
    return (await res.json()).partner.id;
  };

  type TermsJson = Parameters<
    (typeof e.partners)[":partnerId"]["billing-terms"]["$put"]
  >[0]["json"];
  const setTerms = async (partnerId: string, over: Record<string, unknown> = {}) => {
    const json = {
      billingType: "hourly",
      unitPrice: 10_000,
      dueMonthsAfter: 1,
      dueDay: 31,
      defaultItemName: "業務委託",
      ...over,
    } as TermsJson;
    const res = await e.partners[":partnerId"]["billing-terms"].$put({
      param: { ...param, partnerId },
      json,
    });
    if (res.status !== 200) throw new Error(`terms failed: ${res.status}`);
  };

  type SettingsJson = Parameters<(typeof e)["invoice-settings"]["$put"]>[0]["json"];
  const setSettings = async (over: Record<string, unknown> = {}) => {
    const json = {
      issuerName: "山田 太郎",
      address: "東京都千代田区",
      contact: "taro@example.com",
      bankAccount: "○○銀行\n普通 1234567",
      taxDisplay: "separate",
      nextSeq: 1,
      ...over,
    } as SettingsJson;
    const res = await e["invoice-settings"].$put({ param, json });
    if (res.status !== 200) throw new Error(`settings failed: ${res.status}`);
  };

  /** 2026 年 1 月 1 日から課税事業者（税込経理）にする */
  const makeTaxable = async () => {
    const res = await e["tax-settings"].$put({
      param,
      json: [
        {
          effectiveFrom: "2026-01-01",
          taxpayerStatus: "general",
          accountingMethod: "tax_included",
        },
      ],
    });
    if (res.status !== 200) throw new Error(`tax-settings failed: ${res.status}`);
  };

  return { entityId, client, e, param, accountId, addPartner, setTerms, setSettings, makeTaxable };
}

export type InvoicingTestContext = Awaited<ReturnType<typeof createInvoicingTestContext>>;

/** エラーの応答（{ error }）を除いた成功のボディの型にする */
export const okBody = async <R extends { json(): Promise<unknown> }>(
  res: R,
): Promise<Exclude<Awaited<ReturnType<R["json"]>>, { error: unknown }>> =>
  (await res.json()) as Exclude<Awaited<ReturnType<R["json"]>>, { error: unknown }>;
