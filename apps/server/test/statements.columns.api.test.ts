import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { testClient } from "hono/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.ts";
import { AI_API_KEY_SECRET } from "../src/lib/ai-client.ts";
import type { FmServer } from "../src/lib/fm-server.ts";
import { createMemorySecretStore } from "../src/lib/keychain.ts";
import { createTestEntity, NOW, testHeaders } from "./helpers.ts";
import { statementForm } from "./statements-helpers.ts";

// 007 US4: contracts/http-api.md §4.1 POST /statements/imports/column-suggestion。
// 偽の fetch・キーチェーン・fm で、端末内の AI だけが呼ばれること（FR-018）を確かめる。fm・外部の AI は呼ばない

const KEY = "sk-columns-secret-246813579";
const LOCAL_URL = "http://127.0.0.1:18790/v1/chat/completions";

let tmp: TempDataDir;
beforeEach(() => {
  tmp = useTempDataDir("server-statements-columns-api");
});
afterEach(() => tmp.cleanup());

/** 見出しが辞書に当たらない表（日付・内容・金額の列は AI が決める） */
const CUSTOM =
  "発生日\t取引の内容\t増減額\t整理番号\n2026/10/01\tテスト商事\t100\t1\n2026/10/02\t電気代\t-50\t2\n";
/** 辞書で必須の役割がそろう表 */
const DICT = "日付\t内容\t金額\n2026/10/01\tテスト商事\t100\n";

const GOOD = {
  roles: ["date", "content", "amount", "externalId"],
  amountSign: "inflow_positive",
  confidence: 77,
};

/** AI を使えない・失敗したときは、列の中身から推定した案を理由つきで返す（007/R16。confidence は 0） */
const contentOnly = (unavailable: string) => ({
  suggestion: { columns: { date: 0, content: 1, amount: 2 }, amountSign: null, confidence: 0 },
  unavailable,
});

const completion = (content: unknown) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

type Reply = (url: string, init: RequestInit) => Promise<Response>;

async function setup(
  options: { fmAvailable?: boolean; reply?: Reply; localEnabled?: boolean } = {},
) {
  const entityId = await createTestEntity();
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return (options.reply ?? (async () => completion(JSON.stringify(GOOD))))(
      String(url),
      init ?? {},
    );
  });
  const fm: FmServer = {
    available: async () => options.fmAvailable ?? true,
    ensureStarted: async () =>
      (options.fmAvailable ?? true) ? "http://127.0.0.1:18790" : undefined,
    stop: () => {},
  };
  const secrets = createMemorySecretStore();
  const app = createApp({
    clock: { now: () => NOW },
    ai: { fetch: fetchFn as unknown as typeof fetch, secrets, fm },
  });
  const client = testClient(app, undefined, undefined, { headers: testHeaders });
  const e = client.api.entities[":entityId"];
  const suggest = async (text: string, extra: Record<string, unknown> = {}) => {
    const res = await e.statements.imports["column-suggestion"].$post(
      { param: { entityId } },
      { init: { body: statementForm(text, { origin: "paste", ...extra }) } },
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const putAi = (json: Record<string, unknown>) =>
    client.api.settings.ai.$put({ json: { receiptImagesEnabled: false, ...json } as never });
  // 既定は端末内が無効（非推奨）。既定でこのテストの対象にするため、明示的に有効にする
  if (options.localEnabled !== false) {
    const res = await putAi({ localEnabled: true, externalEnabled: false });
    expect(res.status).toBe(200);
  }
  return { calls, fetchFn, secrets, suggest, putAi, client };
}

describe("POST /statements/imports/column-suggestion", () => {
  it("端末内の AI が有効なら、端末内の URL にだけ要求して案を返す（API キーなし）", async () => {
    const t = await setup();
    const { status, body } = await t.suggest(CUSTOM);
    expect(status).toBe(200);
    expect(body.suggestion).toMatchObject({
      columns: { date: 0, content: 1, amount: 2, externalId: 3 },
      amountSign: "inflow_positive",
      confidence: 77,
    });
    expect(body.suggestion).not.toHaveProperty("reason");
    expect(body).not.toHaveProperty("unavailable");
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]?.url).toBe(LOCAL_URL);
    expect(new Headers(t.calls[0]?.init.headers).has("authorization")).toBe(false);
    expect(t.calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
    const sent = JSON.parse(String(t.calls[0]?.init.body)) as { model: string };
    expect(sent.model).toBe("system");
  });

  it("外部の AI の設定と API キーがあっても、外部の URL へは 1 回も要求しない（FR-018）", async () => {
    const t = await setup();
    expect(
      (
        await t.putAi({
          localEnabled: true,
          externalEnabled: true,
          externalBaseUrl: "https://api.example.com",
          externalModel: "model-a",
          apiKey: KEY,
        })
      ).status,
    ).toBe(200);
    expect(await t.secrets.get(AI_API_KEY_SECRET)).toBe(KEY);

    const { body } = await t.suggest(CUSTOM);
    expect(body.suggestion).not.toBeNull();
    expect(t.calls.map((c) => c.url)).toEqual([LOCAL_URL]);
    expect(JSON.stringify(t.calls)).not.toContain(KEY);
    expect(JSON.stringify(t.calls)).not.toContain("api.example.com");
  });

  it("設定を保存していない既定（端末内は無効）では disabled で、fetch は呼ばれない", async () => {
    const t = await setup({ localEnabled: false });
    const { status, body } = await t.suggest(CUSTOM);
    expect(status).toBe(200);
    expect(body).toEqual(contentOnly("disabled"));
    expect(t.fetchFn).not.toHaveBeenCalled();
  });

  it("端末内が設定で無効なら disabled で、fetch は呼ばれない（外部が有効でも呼ばない）", async () => {
    const t = await setup();
    await t.putAi({
      localEnabled: false,
      externalEnabled: true,
      externalBaseUrl: "https://api.example.com",
      externalModel: "model-a",
      apiKey: KEY,
    });
    const { status, body } = await t.suggest(CUSTOM);
    expect(status).toBe(200);
    expect(body).toEqual(contentOnly("disabled"));
    expect(t.fetchFn).not.toHaveBeenCalled();
  });

  it("端末内は有効でも fm が使えなければ unavailable", async () => {
    const t = await setup({ fmAvailable: false });
    const { body } = await t.suggest(CUSTOM);
    expect(body).toEqual(contentOnly("unavailable"));
    expect(t.fetchFn).not.toHaveBeenCalled();
  });

  it("時間切れは timeout", async () => {
    const t = await setup({
      reply: async () => {
        throw new DOMException("timed out", "TimeoutError");
      },
    });
    const { status, body } = await t.suggest(CUSTOM);
    expect(status).toBe(200);
    expect(body).toEqual(contentOnly("timeout"));
  });

  it("接続の失敗・HTTP エラーは unavailable", async () => {
    const down = await setup({
      reply: async () => {
        throw new TypeError("fetch failed");
      },
    });
    expect((await down.suggest(CUSTOM)).body).toEqual(contentOnly("unavailable"));
    const http = await setup({ reply: async () => new Response("", { status: 500 }) });
    expect((await http.suggest(CUSTOM)).body).toEqual(contentOnly("unavailable"));
  });

  it("形の誤り（JSON でない・役割の数が列数と違う・必須の役割が足りない）は invalid", async () => {
    for (const content of [
      "これは JSON ではありません",
      JSON.stringify({ ...GOOD, roles: [...GOOD.roles, "memo"] }),
      JSON.stringify({
        ...GOOD,
        roles: GOOD.roles.map((r) => (r === "amount" ? "none" : r)),
      }),
    ]) {
      const t = await setup({ reply: async () => completion(content) });
      expect((await t.suggest(CUSTOM)).body).toEqual(contentOnly("invalid"));
    }
  });

  it("辞書で必須の役割がそろう表では AI を呼ばない（suggestion: null、unavailable なし）", async () => {
    const t = await setup();
    const { status, body } = await t.suggest(DICT);
    expect(status).toBe(200);
    expect(body).toEqual({ suggestion: null });
    expect(t.fetchFn).not.toHaveBeenCalled();
  });

  it("delimiter・headerRow の選び直しを layout と同じに読む。読めない表は 422", async () => {
    const t = await setup();
    const csv = "発生日,取引の内容,増減額\n2026/10/01,A,100\n";
    const { status } = await t.suggest(csv, { delimiter: "," });
    expect(status).toBe(200);
    expect(t.calls).toHaveLength(1);
    const empty = await t.suggest("  \n");
    expect(empty.status).toBe(422);
    expect(t.calls).toHaveLength(1);
  });
});
