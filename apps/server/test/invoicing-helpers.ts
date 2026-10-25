import { testClient } from "hono/testing";
import { createApp } from "../src/app.ts";
import {
  accountLookup,
  createTestEntity,
  createTestSession,
  TEST_HOST,
  TEST_ORIGIN,
} from "./helpers.ts";

export { okBody } from "./helpers.ts";

/**
 * 請求書（005）の server のテストの共通部品（`helpers.ts` を拡張する）。偽の時計（`now`）で
 * `createApp({ clock })` を作り、その時刻のセッションで呼ぶ。時刻は UTC と JST の 0 時から離す（CI の `TZ` に依存させない）
 */

/**
 * 日付の境目（UTC・JST の 0 時）から離した時刻。UTC 03:00 = JST 12:00（同じ暦日）で、今日は 2026-10-31。
 * domain・db のテストの `NOW`（`packages/domain/test/test-dates.ts`）とは別の値
 */
const SAFE_NOW = "2026-10-31T03:00:00.000Z";
export const TODAY = "2026-10-31";

export async function createInvoicingTestContext(now = SAFE_NOW) {
  const entityId = await createTestEntity();
  const session = await createTestSession({ now });
  const client = testClient(createApp({ clock: { now: () => now } }), undefined, undefined, {
    headers: { Host: TEST_HOST, Origin: TEST_ORIGIN, Cookie: session.cookie },
  });
  const e = client.api.entities[":entityId"];
  const param = { entityId };

  const accountId = await accountLookup(entityId);

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
