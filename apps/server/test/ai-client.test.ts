import type { SuggestionContext, SuggestionPayload } from "@trebuchet/domain";
import { describe, expect, it, vi } from "vitest";
import {
  AI_API_KEY_SECRET,
  type AiEndpoint,
  createOpenAiProvider,
  EXTERNAL_TIMEOUT_MS,
  LOCAL_TIMEOUT_MS,
} from "../src/lib/ai-client.ts";

// 006 R10: OpenAI 互換の Chat Completions を fetch で呼ぶ。実際のネットワークには出ない（偽の fetch）

const PAYLOAD: SuggestionPayload = {
  date: "2026-05-10",
  amount: 1200,
  direction: "out",
  content: "ショップ####",
  categoryMajor: "日用品",
  categoryMinor: null,
  accountKind: "bank",
  accountUsage: "business",
};

const CONTEXT: SuggestionContext = {
  accounts: [
    { code: "5100", name: "消耗品費" },
    { code: "5200", name: "旅費交通費" },
  ],
  taxCategories: ["taxable_10", "exempt"],
};

const SUGGESTION_TEXT = JSON.stringify({
  accountCode: "5100",
  taxCategory: "taxable_10",
  purpose: "business",
  confidence: 80,
  reason: "文房具の購入",
});

const completion = (content: unknown) =>
  new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

type Call = { url: string; init: RequestInit; body: Record<string, unknown> };

/** 呼び出しを記録し、応答を順に返す偽の fetch */
function fakeFetch(
  ...responses: (Response | Error | ((init: RequestInit) => Promise<Response>))[]
) {
  const calls: Call[] = [];
  const queue = [...responses];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const i = init ?? {};
    calls.push({
      url: String(input),
      init: i,
      body: JSON.parse(String(i.body ?? "{}")) as Record<string, unknown>,
    });
    const next = queue.shift() ?? new Response("", { status: 500 });
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next(i);
    return next;
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const provider = (
  f: typeof fetch,
  endpoint: AiEndpoint | null = {
    baseUrl: "https://api.example.com",
    model: "model-a",
    apiKey: "sk-secret-123",
  },
  timeoutMs = 1000,
) =>
  createOpenAiProvider({
    fetch: f,
    timeoutMs,
    available: async () => endpoint !== null,
    endpoint: async () => endpoint ?? undefined,
  });

describe("createOpenAiProvider: 要求", () => {
  it("POST {baseUrl}/v1/chat/completions に、model・system と user のメッセージ・response_format を送る。API キーは Authorization だけ", async () => {
    const { fn, calls } = fakeFetch(completion(SUGGESTION_TEXT));
    const result = await provider(fn, {
      baseUrl: "https://api.example.com/",
      model: "model-a",
      apiKey: "sk-secret-123",
    }).suggest(PAYLOAD, CONTEXT);

    expect(result).toEqual({ ok: true, value: SUGGESTION_TEXT });
    expect(calls).toHaveLength(1);
    const call = calls[0] as Call;
    expect(call.url).toBe("https://api.example.com/v1/chat/completions");
    expect(call.init.method).toBe("POST");
    const headers = new Headers(call.init.headers);
    expect(headers.get("authorization")).toBe("Bearer sk-secret-123");
    expect(headers.get("content-type")).toBe("application/json");
    expect(call.body.model).toBe("model-a");
    const messages = call.body.messages as { role: string; content: string }[];
    expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(messages[0]?.content).toContain("5100 消耗品費");
    expect(messages[1]?.content).toBe(JSON.stringify(PAYLOAD));
    expect((call.body.response_format as { type: string }).type).toBe("json_schema");
    // API キーは本文に入らない
    expect(JSON.stringify(call.body)).not.toContain("sk-secret-123");
  });

  it("API キーがない接続先（端末内）には Authorization を付けない", async () => {
    const { fn, calls } = fakeFetch(completion(SUGGESTION_TEXT));
    await provider(fn, { baseUrl: "http://127.0.0.1:18790", model: "fm" }).suggest(
      PAYLOAD,
      CONTEXT,
    );
    expect(new Headers(calls[0]?.init.headers).has("authorization")).toBe(false);
  });

  it("時間切れの既定は端末内 30 秒・外部 60 秒", () => {
    expect(LOCAL_TIMEOUT_MS).toBe(30_000);
    expect(EXTERNAL_TIMEOUT_MS).toBe(60_000);
    expect(AI_API_KEY_SECRET).toBe("trebuchet-ai-api-key");
  });
});

describe("createOpenAiProvider: 応答", () => {
  it("message.content の文字列を、検証せずそのまま返す（検証はドメインの parseSuggestion）", async () => {
    const { fn } = fakeFetch(completion("```json\n{bad}\n```"));
    expect(await provider(fn).suggest(PAYLOAD, CONTEXT)).toEqual({
      ok: true,
      value: "```json\n{bad}\n```",
    });
  });

  it("response_format を受けない接続先（400）には、response_format なしで 1 回だけ再試行する", async () => {
    const { fn, calls } = fakeFetch(
      new Response('{"error":"unsupported response_format"}', { status: 400 }),
      completion(SUGGESTION_TEXT),
    );
    const result = await provider(fn).suggest(PAYLOAD, CONTEXT);
    expect(result).toEqual({ ok: true, value: SUGGESTION_TEXT });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body.response_format).toBeDefined();
    expect(calls[1]?.body.response_format).toBeUndefined();
  });

  it("再試行でも失敗、または 400 以外の失敗は err。メッセージに API キーも応答の本文も含めない", async () => {
    const { fn, calls } = fakeFetch(
      new Response("sk-secret-123 echoed by the server", { status: 401 }),
    );
    const result = await provider(fn).suggest(PAYLOAD, CONTEXT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(calls).toHaveLength(1);
    expect(result.error.message).toContain("401");
    expect(JSON.stringify(result.error)).not.toContain("sk-secret-123");
    expect(JSON.stringify(result.error)).not.toContain("echoed");
  });

  it("content が文字列でない・choices がない・JSON でない応答は err", async () => {
    for (const response of [
      completion(null),
      completion({ not: "a string" }),
      new Response(JSON.stringify({ choices: [] }), { status: 200 }),
      new Response("<html>", { status: 200 }),
    ]) {
      const { fn } = fakeFetch(response);
      const result = await provider(fn).suggest(PAYLOAD, CONTEXT);
      expect(result.ok).toBe(false);
    }
  });

  it("接続エラーは err。元のエラーのメッセージ（URL や内部の事情）は出さない", async () => {
    const { fn } = fakeFetch(new TypeError("fetch failed: connect ECONNREFUSED sk-secret-123"));
    const result = await provider(fn).suggest(PAYLOAD, CONTEXT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(JSON.stringify(result.error)).not.toContain("ECONNREFUSED");
    expect(JSON.stringify(result.error)).not.toContain("sk-secret-123");
  });

  it("時間切れ（AbortSignal）は err になり、再試行しない", async () => {
    const hang = (init: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const { fn, calls } = fakeFetch(hang, hang);
    const result = await provider(fn, undefined, 20).suggest(PAYLOAD, CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("時間");
    expect(calls).toHaveLength(1);
  });
});

describe("createOpenAiProvider: 使えるか", () => {
  it("available は渡された判定に従い、使えないときの suggest は fetch せず AI_NOT_CONFIGURED", async () => {
    const { fn, calls } = fakeFetch();
    const p = provider(fn, null);
    expect(await p.available()).toBe(false);
    const result = await p.suggest(PAYLOAD, CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("AI_NOT_CONFIGURED");
    expect(calls).toHaveLength(0);
  });
});
