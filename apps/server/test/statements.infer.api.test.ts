import { randomUUIDv7 } from "node:crypto";
import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { testClient } from "hono/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.ts";
import { AI_API_KEY_SECRET } from "../src/lib/ai-client.ts";
import type { FmServer } from "../src/lib/fm-server.ts";
import { createMemorySecretStore } from "../src/lib/keychain.ts";
import {
  accountLookup,
  createTestEntity,
  createTestSession,
  errorOf,
  okBody,
  TEST_HOST,
  TEST_ORIGIN,
} from "./helpers.ts";
import { importStatementLines } from "./statements-helpers.ts";

// 006 §4.3: POST /statements/infer。偽の fetch・キーチェーン・fm で、設定 → 呼び出し → 候補の保存までを通す

const NOW = "2026-10-31T03:00:00.000Z";
const KEY = "sk-infer-secret-987654321";
const BANK = "サンプル銀行";

let tmp: TempDataDir;
beforeEach(() => {
  tmp = useTempDataDir("server-statements-infer-api");
});
afterEach(() => tmp.cleanup());

const completion = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

async function setup(options: { fmAvailable?: boolean; reply?: (code: string) => string } = {}) {
  const entityId = await createTestEntity();
  const accountId = await accountLookup(entityId);
  const session = await createTestSession({ now: NOW });
  const codeOf = async (name: string) => {
    const client = testClient(createApp({ clock: { now: () => NOW } }), undefined, undefined, {
      headers: { Host: TEST_HOST, Origin: TEST_ORIGIN, Cookie: session.cookie },
    });
    const res = await client.api.entities[":entityId"].accounts.$get({ param: { entityId } });
    const found = (await res.json()).accounts.find((a) => a.name === name);
    if (found === undefined) throw new Error(`科目がない: ${name}`);
    return found.code;
  };
  const supplies = await codeOf("消耗品費");

  const calls: { url: string; init: RequestInit }[] = [];
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
            confidence: 82,
            reason: "文房具の購入",
          }))
      )(supplies),
    );
  });
  const fm: FmServer = {
    available: async () => options.fmAvailable ?? false,
    ensureStarted: async () => (options.fmAvailable ? "http://127.0.0.1:18790" : undefined),
    stop: () => {},
  };
  const secrets = createMemorySecretStore();
  const app = createApp({
    clock: { now: () => NOW },
    ai: { fetch: fetchFn as unknown as typeof fetch, secrets, fm },
  });
  const client = testClient(app, undefined, undefined, {
    headers: { Host: TEST_HOST, Origin: TEST_ORIGIN, Cookie: session.cookie },
  });
  const e = client.api.entities[":entityId"];
  const param = { entityId };

  const mapped = await e["statement-accounts"][":name"].$put({
    param: { ...param, name: BANK },
    json: { usage: "business", kind: "bank", accountId: accountId("普通預金") },
  });
  expect(mapped.status).toBe(200);
  await importStatementLines(
    e.statements.imports,
    param,
    ["05/10(日)", "文房具", "-1,200", BANK, "", 0].join("\t"),
  );
  const statements = (await okBody(await e.statements.$get({ param, query: {} }))).statements;
  const statementId = statements[0]?.id ?? "";

  const putAi = (json: Record<string, unknown>) =>
    client.api.settings.ai.$put({ json: json as never });
  const infer = (statementIds: string[]) =>
    e.statements.infer.$post({ param, json: { statementIds } });
  const candidate = async () =>
    (await okBody(await e.statements.$get({ param, query: {} }))).statements[0]?.candidate;
  return { e, param, statementId, calls, putAi, infer, candidate, secrets, supplies };
}

const EXTERNAL = {
  localEnabled: true,
  externalEnabled: true,
  externalBaseUrl: "https://api.example.com",
  externalModel: "model-a",
  apiKey: KEY,
};

describe("POST /statements/infer", () => {
  it("外部の AI が有効なら、設定の接続先・モデル・API キーで呼び、候補を external_ai で保存する", async () => {
    const t = await setup();
    expect((await t.putAi(EXTERNAL)).status).toBe(200);
    expect(await t.secrets.get(AI_API_KEY_SECRET)).toBe(KEY);

    const res = await t.infer([t.statementId]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      results: [{ statementId: t.statementId, method: "external_ai", confidence: 82 }],
      localAvailable: false,
      externalUsed: true,
    });
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]?.url).toBe("https://api.example.com/v1/chat/completions");
    expect(new Headers(t.calls[0]?.init.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(t.calls[0]?.init.body)).model).toBe("model-a");

    expect(await t.candidate()).toMatchObject({
      method: "external_ai",
      confidence: 82,
      model: "model-a",
    });
  });

  it("端末内（fm）が使えれば、fm の接続先を API キーなしで呼び、model は fm。確信度が高ければ外部を呼ばない", async () => {
    const t = await setup({ fmAvailable: true });
    await t.putAi(EXTERNAL);
    const res = await t.infer([t.statementId]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      results: [{ statementId: t.statementId, method: "local_ai", confidence: 82 }],
      localAvailable: true,
      externalUsed: false,
    });
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]?.url).toBe("http://127.0.0.1:18790/v1/chat/completions");
    expect(new Headers(t.calls[0]?.init.headers).has("authorization")).toBe(false);
    expect(JSON.parse(String(t.calls[0]?.init.body)).model).toBe("system");
    expect((await t.candidate())?.model).toBe("system");
  });

  it("端末内を無効にすると fm を使わない。外部も無効なら AI を呼ばず none", async () => {
    const t = await setup({ fmAvailable: true });
    await t.putAi({ localEnabled: false, externalEnabled: false });
    const res = await t.infer([t.statementId]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      results: [{ statementId: t.statementId, method: "none", confidence: null }],
      localAvailable: false,
      externalUsed: false,
    });
    expect(t.calls).toHaveLength(0);
  });

  it("AI の出力が一覧にない科目なら、候補は none（理由つき）で、API キーはどこにも出ない", async () => {
    const t = await setup({
      reply: () =>
        JSON.stringify({
          accountCode: "9999",
          taxCategory: "PURCHASE_10",
          purpose: "business",
          confidence: 90,
          reason: "x",
        }),
    });
    await t.putAi(EXTERNAL);
    const res = await t.infer([t.statementId]);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ results: [{ method: "none" }] });
    const candidate = await t.candidate();
    expect(candidate?.method).toBe("none");
    expect(JSON.stringify(candidate)).not.toContain(KEY);
  });

  it("10 件を超える・0 件・不正な ID は 400 VALIDATION、未知の明細は 404 STATEMENT_NOT_FOUND", async () => {
    const t = await setup();
    for (const ids of [[], Array.from({ length: 11 }, (_, i) => `id-${i}`), [""]]) {
      const res = await t.infer(ids);
      expect(res.status).toBe(400);
      expect((await errorOf(res)).code).toBe("VALIDATION");
    }
    const missing = await t.infer([randomUUIDv7()]);
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).code).toBe("STATEMENT_NOT_FOUND");
  });
});
