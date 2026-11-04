import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { testClient } from "hono/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.ts";
import type { FmServer } from "../src/lib/fm-server.ts";
import { createMemorySecretStore } from "../src/lib/keychain.ts";
import { createTestEntity, createTestSession, errorOf, TEST_HOST, TEST_ORIGIN } from "./helpers.ts";

// 011 T043（R19、contracts §1）: POST /journals/ai-suggestion。偽の fetch・キーチェーン・fm で、
// 設定 → 呼び出し → 検証までを通す。AI は呼ばない（実際のネットワークに出ない）。候補は保存しない

const NOW = "2026-10-31T03:00:00.000Z";
const KEY = "sk-journal-secret-987654321";

let tmp: TempDataDir;
beforeEach(() => {
  tmp = useTempDataDir("server-journals-ai-suggestion-api");
});
afterEach(() => tmp.cleanup());

const completion = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

const EXTERNAL = {
  localEnabled: false,
  externalEnabled: true,
  externalBaseUrl: "https://api.example.com",
  externalModel: "model-a",
  apiKey: KEY,
};

async function setup(options: { fmAvailable?: boolean; reply?: (code: string) => string } = {}) {
  const entityId = await createTestEntity();
  const session = await createTestSession({ now: NOW });
  const calls: { url: string; init: RequestInit }[] = [];
  let supplies = "";
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return completion(
      (
        options.reply ??
        ((code) =>
          JSON.stringify({
            accountCode: code,
            taxCategory: "PURCHASE_10",
            purpose: "business",
            confidence: 88,
            reason: "コピー用紙の購入",
          }))
      )(supplies),
    );
  });
  const fm: FmServer = {
    available: async () => options.fmAvailable ?? false,
    ensureStarted: async () => (options.fmAvailable ? "http://127.0.0.1:18790" : undefined),
    stop: () => {},
  };
  const app = createApp({
    clock: { now: () => NOW },
    ai: { fetch: fetchFn as unknown as typeof fetch, secrets: createMemorySecretStore(), fm },
  });
  const client = testClient(app, undefined, undefined, {
    headers: { Host: TEST_HOST, Origin: TEST_ORIGIN, Cookie: session.cookie },
  });
  const e = client.api.entities[":entityId"];
  const param = { entityId };
  const accounts = (await (await e.accounts.$get({ param })).json()).accounts;
  supplies = accounts.find((a) => a.name === "消耗品費")?.code ?? "";
  const putAi = (json: Record<string, unknown>) =>
    client.api.settings.ai.$put({ json: { receiptImagesEnabled: false, ...json } as never });
  const suggest = (json: { date: string; amount: number; memo: string }) =>
    e.journals["ai-suggestion"].$post({ param, json });
  const journals = async () =>
    ((await (await e.journals.$get({ param, query: {} })).json()) as { journals: unknown[] })
      .journals;
  return { calls, putAi, suggest, journals, supplies, e, param };
}

const INPUT = { date: "2026-05-10", amount: 3300, memo: "コピー用紙" };

describe("POST /journals/ai-suggestion", () => {
  it("外部の AI が有効なら、マスクした摘要・金額・日付だけを送り、検証した候補を返す（保存しない）", async () => {
    const t = await setup();
    expect((await t.putAi(EXTERNAL)).status).toBe(200);

    const res = await t.suggest({ ...INPUT, memo: "カード 4111111111111111 コピー用紙" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      suggestion: {
        accountCode: t.supplies,
        taxCategory: "PURCHASE_10",
        purpose: "business",
        confidence: 88,
        reason: "コピー用紙の購入",
      },
    });
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]?.url).toBe("https://api.example.com/v1/chat/completions");
    const body = JSON.parse(String(t.calls[0]?.init.body)) as {
      messages: { role: string; content: string }[];
    };
    expect(JSON.parse(body.messages[1]?.content ?? "")).toEqual({
      date: "2026-05-10",
      amount: 3300,
      memo: "カード #### コピー用紙",
    });
    expect(String(t.calls[0]?.init.body)).not.toContain("4111111111111111");
    // 候補は保存しない（仕訳は増えない）
    expect(await t.journals()).toHaveLength(0);
  });

  it("端末内（fm）が使えて確信度が高ければ、fm の接続先だけを呼ぶ（外部の AI は有効にしておく）", async () => {
    const t = await setup({ fmAvailable: true });
    await t.putAi({ ...EXTERNAL, localEnabled: true });
    const res = await t.suggest(INPUT);
    expect(res.status).toBe(200);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]?.url).toBe("http://127.0.0.1:18790/v1/chat/completions");
    expect(((await res.json()) as { suggestion: unknown }).suggestion).toMatchObject({
      confidence: 88,
    });
  });

  it("外部の AI が無効なら 422 AI_NOT_CONFIGURED。端末内が使えても AI を 1 回も呼ばない", async () => {
    const t = await setup({ fmAvailable: true });
    await t.putAi({ localEnabled: true, externalEnabled: false });
    const res = await t.suggest(INPUT);
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe("AI_NOT_CONFIGURED");
    expect(t.calls).toHaveLength(0);
  });

  it("設定が一度もなくても 422 AI_NOT_CONFIGURED", async () => {
    const t = await setup();
    const res = await t.suggest(INPUT);
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe("AI_NOT_CONFIGURED");
    expect(t.calls).toHaveLength(0);
  });

  it.each([
    ["一覧にない科目", () => JSON.stringify({ accountCode: "9999", taxCategory: "PURCHASE_10" })],
    [
      "一覧にない税区分",
      (code: string) => JSON.stringify({ accountCode: code, taxCategory: "XYZ" }),
    ],
    ["JSON でない出力", () => "分かりません"],
  ])("%s は 200 で suggestion: null（INV-46）。理由を返す", async (_name, partial) => {
    const t = await setup({
      reply: (code) => {
        const text = partial(code);
        return text.startsWith("{")
          ? JSON.stringify({
              purpose: "business",
              confidence: 90,
              reason: "x",
              ...(JSON.parse(text) as object),
            })
          : text;
      },
    });
    await t.putAi(EXTERNAL);
    const res = await t.suggest(INPUT);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { suggestion: unknown; reason?: string };
    expect(json.suggestion).toBeNull();
    expect(json.reason).toEqual(expect.any(String));
    expect(await t.journals()).toHaveLength(0);
  });

  it.each([
    ["金額が 0", { ...INPUT, amount: 0 }],
    ["金額が小数", { ...INPUT, amount: 10.5 }],
    ["金額が 1 兆以上", { ...INPUT, amount: 1_000_000_000_000 }],
    ["摘要が空", { ...INPUT, memo: "" }],
    ["摘要が空白だけ", { ...INPUT, memo: "   " }],
  ])("入力が不正なら 400。AI を呼ばない: %s", async (_name, json) => {
    const t = await setup();
    await t.putAi(EXTERNAL);
    const res = await t.suggest(json);
    expect(res.status).toBe(400);
    expect(t.calls).toHaveLength(0);
  });
});
