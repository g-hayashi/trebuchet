import { clearDataKey } from "@trebuchet/db";
import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import type { JournalInput } from "@trebuchet/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { app as realApp } from "../src/app.ts";
import {
  accountLookup,
  app,
  createTestEntity,
  errorOf,
  json,
  TEST_HOST,
  testHeaders,
} from "./helpers.ts";

let tmp: TempDataDir;
let entityId: string;
let acc: (name: string) => string;
const base = () => `/api/entities/${entityId}/journals`;
beforeEach(async () => {
  tmp = useTempDataDir("server-journal-suggestions");
  entityId = await createTestEntity();
  acc = await accountLookup(entityId);
});
afterEach(() => tmp.cleanup());

async function post(memo: string, extra: Partial<JournalInput> = {}) {
  const res = await app.request(base(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      date: "2026-10-01",
      memo,
      lines: [
        { side: "debit", accountId: acc("消耗品費"), amount: 100 },
        { side: "credit", accountId: acc("現金"), amount: 100 },
      ],
      ...extra,
    }),
  });
  return (await json<{ journal: { id: string } }>(res, 201)).journal;
}

describe("GET /journals/suggestions", () => {
  it("正規化した摘要で候補を返し、/:journalId より先に解決する", async () => {
    const journal = await post("ＡＢＣ　123");
    const body = await json<{ suggestions: unknown[] }>(
      await app.request(`${base()}/suggestions?memo=abc999`),
      200,
    );
    expect(body.suggestions).toEqual([
      {
        debitAccountId: acc("消耗品費"),
        creditAccountId: acc("現金"),
        debitTaxCategory: "OUT_OF_SCOPE",
        creditTaxCategory: "OUT_OF_SCOPE",
        debitPartnerId: null,
        creditPartnerId: null,
        sourceJournalId: journal.id,
        date: "2026-10-01",
      },
    ]);
  });

  it("全履歴を検索し、直近200件に一致がなくても古い候補を返す", async () => {
    const old = await post("一致する摘要");
    for (let i = 0; i < 201; i++) await post("一致しない摘要");
    const body = await json<{ suggestions: { sourceJournalId: string }[] }>(
      await app.request(`${base()}/suggestions?memo=${encodeURIComponent("一致する摘要")}`),
      200,
    );
    expect(body.suggestions.map((s) => s.sourceJournalId)).toEqual([old.id]);
  });

  it("取引先だけでも候補を検索し、取消と多行を除外する", async () => {
    const partnerResponse = await app.request(`/api/entities/${entityId}/partners`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "合成取引先", honorific: "御中" }),
    });
    const { partner } = await json<{ partner: { id: string } }>(partnerResponse, 201);
    const lines: [JournalInput["lines"][number], JournalInput["lines"][number]] = [
      { side: "debit", accountId: acc("消耗品費"), amount: 100, partnerId: partner.id },
      { side: "credit", accountId: acc("現金"), amount: 100 },
    ];
    const valid = await post("別の摘要", { lines });
    const voided = await post("取消済み", { lines });
    const cancelled = await app.request(`${base()}/${voided.id}/void`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "合成取消", version: 1 }),
    });
    expect(cancelled.status).toBe(200);
    await post("多行", {
      lines: [{ ...lines[0], amount: 50 }, { ...lines[0], amount: 50 }, lines[1]],
    });
    const body = await json<{ suggestions: { sourceJournalId: string }[] }>(
      await app.request(`${base()}/suggestions?partnerId=${partner.id}`),
      200,
    );
    expect(body.suggestions.map((s) => s.sourceJournalId)).toEqual([valid.id]);
  });

  it("有効な条件に一致がなければ空の配列", async () => {
    expect(await json(await app.request(`${base()}/suggestions?memo=none`), 200)).toEqual({
      suggestions: [],
    });
  });

  it.each(["", "?memo=", "?memo=%20", `?memo=${"a".repeat(201)}`, "?partnerId=invalid"])(
    "無効な条件 %s は400",
    async (query) => {
      const res = await app.request(`${base()}/suggestions${query}`);
      expect(res.status).toBe(400);
      expect((await errorOf(res)).code).toBe("VALIDATION");
    },
  );

  it("未認証と施錠中を拒否する", async () => {
    const path = `${base()}/suggestions?memo=test`;
    const unauth = await realApp.request(path, { headers: { Host: TEST_HOST } });
    expect(unauth.status).toBe(401);
    expect((await errorOf(unauth)).code).toBe("UNAUTHENTICATED");
    const headers = await testHeaders();
    clearDataKey();
    const locked = await realApp.request(path, { headers });
    expect(locked.status).toBe(401);
    expect((await errorOf(locked)).code).toBe("LOCKED");
  });
});
